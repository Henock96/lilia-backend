/* eslint-disable prettier/prettier */
import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { OrderStatus, OutboxEvent } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { CronLockService } from '../../common/locks/cron-lock.service';
import { NotificationsService } from '../notifications/notifications.service';
import { SmsService } from '../sms/sms.service';
import { OutboxService } from './outbox.service';
import { VendorInvitationService } from '../vendors/vendor-invitation.service';
import { VENDOR_INVITATION_EVENT } from '../vendors/events/vendor-events';

/**
 * Dépilage de la boîte d'envoi (fix H7 — audit du 28/08/2026).
 *
 * Le chemin rapide reste l'événement en mémoire : `OrdersListener` envoie le
 * push dans la seconde et acquitte l'entrée d'outbox. Ce worker n'intervient
 * que pour ce qui est resté sur le carreau — process mort avant l'envoi,
 * erreur de listener avalée, vendeur sans token FCM.
 *
 * Trois niveaux, dans l'ordre :
 *  1. **retry** du push, avec backoff exponentiel (30 s → 15 min) ;
 *  2. **escalade SMS** au vendeur si la commande n'a pas bougé au bout de
 *     `ESCALATION_MINUTES` — c'est le canal qui marche même sans app ouverte ;
 *  3. **abandon tracé** (`FAILED`) après `MAX_ATTEMPTS`, pour enquête.
 */
@Injectable()
export class OutboxDispatcherService {
  private readonly logger = new Logger(OutboxDispatcherService.name);

  /** Délai avant qu'un événement non acquitté soit considéré en souffrance. */
  private static readonly GRACE_SECONDS = 60;
  private static readonly BATCH_SIZE = 50;
  private static readonly MAX_ATTEMPTS = 8;
  /** Au-delà, on ne compte plus sur le push : SMS au vendeur. */
  private static readonly ESCALATION_MINUTES = 10;

  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
    private readonly notifications: NotificationsService,
    private readonly sms: SmsService,
    private readonly lock: CronLockService,
    private readonly invitations: VendorInvitationService,
  ) {}

  @Cron(CronExpression.EVERY_30_SECONDS)
  async dispatchPending(): Promise<void> {
    await this.lock.runExclusively('outbox-dispatcher', 60, async () => {
      const events = await this.outbox.claimDue({
        graceSeconds: OutboxDispatcherService.GRACE_SECONDS,
        batchSize: OutboxDispatcherService.BATCH_SIZE,
      });

      if (events.length === 0) return;

      this.logger.warn(
        `📬 ${events.length} notification(s) en souffrance — reprise par l'outbox`,
      );

      for (const event of events) {
        await this.dispatchOne(event).catch(async (err) => {
          const message = (err as Error).message;
          if (event.attempts + 1 >= OutboxDispatcherService.MAX_ATTEMPTS) {
            await this.outbox.markFailed(event.id, message);
            this.logger.error(
              `📬 Abandon de l'événement ${event.type} (${event.aggregateId}) après ${event.attempts + 1} tentatives : ${message}`,
            );
          } else {
            await this.outbox.scheduleRetry(event.id, event.attempts, message);
          }
        });
      }
    });
  }

  private async dispatchOne(event: OutboxEvent): Promise<void> {
    switch (event.type) {
      case 'order.created':
        // Conservé pour les lignes écrites AVANT le chantier pawaPay : elles
        // existent encore en base au déploiement et doivent être dépilées.
        // Aucune nouvelle n'est créée avec ce type.
        await this.dispatchOrderCreated(event);
        return;
      case 'order.paid':
        await this.dispatchOrderPaid(event);
        return;
      case VENDOR_INVITATION_EVENT:
        await this.dispatchVendorInvitation(event);
        return;
      default:
        // Type inconnu : on ne le rejoue pas indéfiniment.
        await this.outbox.markFailed(
          event.id,
          `Type d'événement non géré : ${event.type}`,
        );
    }
  }

  /**
   * Renotifie le vendeur d'une commande qu'il n'a pas encore prise en charge.
   * Une commande passée `EN_PREPARATION` (ou plus loin, ou annulée) n'a plus
   * besoin d'être signalée : l'entrée est acquittée.
   */
  private async dispatchOrderCreated(event: OutboxEvent): Promise<void> {
    const order = await this.prisma.order.findUnique({
      where: { id: event.aggregateId },
      select: {
        id: true,
        status: true,
        total: true,
        createdAt: true,
        restaurant: {
          select: { nom: true, ownerId: true, owner: { select: { phone: true } } },
        },
      },
    });

    if (!order) {
      await this.outbox.markFailed(event.id, 'Commande introuvable');
      return;
    }

    const stillUnhandled =
      order.status === OrderStatus.EN_ATTENTE ||
      order.status === OrderStatus.PAYER;

    if (!stillUnhandled) {
      // Le vendeur a vu la commande : le signal a atteint sa cible, quelle
      // qu'ait été la voie.
      await this.outbox.markSent(event.id);
      return;
    }

    await this.notifications.sendPushNotification(
      order.restaurant.ownerId,
      '🔔 Nouvelle commande en attente',
      `${order.total} FCFA — commande non ouverte`,
      { orderId: order.id, type: 'new_order', source: 'outbox' },
    );

    const ageMinutes = (Date.now() - order.createdAt.getTime()) / 60000;
    const shouldEscalate =
      !event.escalatedAt &&
      ageMinutes >= OutboxDispatcherService.ESCALATION_MINUTES;

    if (shouldEscalate) {
      const phone = order.restaurant.owner?.phone;
      if (phone) {
        await this.sms.send(
          phone,
          `Lilia Food : une commande de ${Math.round(order.total)} FCFA attend depuis ${Math.round(ageMinutes)} min. Ouvrez l'application pour la preparer.`,
        );
        await this.outbox.markEscalated(event.id);
        this.logger.warn(
          `📨 Escalade SMS au vendeur pour la commande ${order.id} (${Math.round(ageMinutes)} min sans prise en charge)`,
        );
      } else {
        this.logger.error(
          `Escalade impossible pour la commande ${order.id} : le vendeur n'a pas de téléphone renseigné.`,
        );
      }
    }

    // On NE marque pas SENT : tant que la commande n'est pas prise en charge,
    // l'obligation demeure. Le backoff espace les rappels.
    await this.outbox.scheduleRetry(
      event.id,
      event.attempts,
      'Commande toujours non prise en charge',
    );
  }

  /**
   * Rattrape la notification d'une commande **payée** que le vendeur n'a pas
   * encore prise en charge.
   *
   * Différence avec `dispatchOrderCreated` : seul `PAYER` compte comme « pas
   * encore pris en charge ». Une commande en `EN_ATTENTE` n'est pas payée, elle
   * n'a rien à faire dans la file du vendeur — et une commande passée en
   * `EN_PREPARATION` a été vue, l'obligation est remplie.
   */
  private async dispatchOrderPaid(event: OutboxEvent): Promise<void> {
    const order = await this.prisma.order.findUnique({
      where: { id: event.aggregateId },
      select: {
        id: true,
        status: true,
        total: true,
        createdAt: true,
        paidAt: true,
        restaurant: {
          select: {
            nom: true,
            ownerId: true,
            owner: { select: { phone: true } },
          },
        },
      },
    });

    if (!order) {
      await this.outbox.markFailed(event.id, 'Commande introuvable');
      return;
    }

    if (order.status !== OrderStatus.PAYER) {
      // Soit le vendeur l'a acceptée, soit elle a été annulée : dans les deux
      // cas, le signal a atteint sa cible ou n'a plus lieu d'être.
      await this.outbox.markSent(event.id);
      return;
    }

    await this.notifications.sendPushNotification(
      order.restaurant.ownerId,
      '🔔 Commande payée en attente',
      `${Math.round(order.total)} FCFA — à accepter`,
      { orderId: order.id, type: 'new_order', source: 'outbox' },
    );

    // L'ancienneté se mesure depuis le PAIEMENT, pas depuis la création : une
    // commande créée il y a une heure et payée il y a trente secondes ne doit
    // pas déclencher une escalade immédiate.
    const reference = order.paidAt ?? order.createdAt;
    const ageMinutes = (Date.now() - reference.getTime()) / 60000;
    const shouldEscalate =
      !event.escalatedAt &&
      ageMinutes >= OutboxDispatcherService.ESCALATION_MINUTES;

    if (shouldEscalate) {
      const phone = order.restaurant.owner?.phone;
      if (phone) {
        await this.sms.send(
          phone,
          `Lilia Food : une commande payee de ${Math.round(order.total)} FCFA attend depuis ${Math.round(ageMinutes)} min. Ouvrez l'application pour la preparer.`,
        );
        await this.outbox.markEscalated(event.id);
        this.logger.warn(
          `📨 Escalade SMS au vendeur pour la commande payée ${order.id} (${Math.round(ageMinutes)} min)`,
        );
      } else {
        this.logger.error(
          `Escalade impossible pour la commande ${order.id} : le vendeur n'a pas de téléphone renseigné.`,
        );
      }
    }

    // On NE marque pas SENT : tant que la commande n'est pas acceptée,
    // l'obligation demeure. Le backoff espace les rappels.
    await this.outbox.scheduleRetry(
      event.id,
      event.attempts,
      'Commande payée toujours non acceptée',
    );
  }

  /**
   * Rattrape une invitation vendeur qui n'est pas partie.
   *
   * L'envoi immédiat a lieu à la création ; cette reprise couvre le process tué
   * entre le commit et l'envoi, la panne Mailtrap, et l'erreur transitoire
   * Firebase. Sans elle, un vendeur créé pourrait n'être jamais informé de
   * l'existence de son compte — et personne ne s'en apercevrait.
   *
   * L'entrée est acquittée dès que le propriétaire s'est connecté au moins une
   * fois : le but de l'invitation est atteint, quel qu'ait été le canal (y
   * compris un lien transmis à la main par l'administrateur).
   */
  private async dispatchVendorInvitation(event: OutboxEvent): Promise<void> {
    const vendor = await this.prisma.restaurant.findUnique({
      where: { id: event.aggregateId },
      select: { nom: true, owner: { select: { email: true, lastLogin: true } } },
    });

    if (!vendor) {
      await this.outbox.markFailed(event.id, 'Vendeur introuvable');
      return;
    }

    if (vendor.owner.lastLogin) {
      await this.outbox.markSent(event.id);
      return;
    }

    const result = await this.invitations.sendForVendor(event.aggregateId);
    if (result.emailSent) {
      this.logger.log(
        `📨 Invitation vendeur rattrapée pour ${vendor.nom} (${event.aggregateId})`,
      );
      await this.outbox.markSent(event.id);
      return;
    }

    // Toujours pas d'e-mail : on garde l'obligation ouverte. L'administrateur
    // dispose du lien de repli côté API, et l'abandon après MAX_ATTEMPTS laisse
    // une trace interrogeable plutôt qu'un silence.
    await this.outbox.scheduleRetry(
      event.id,
      event.attempts,
      result.detail,
    );
  }
}
