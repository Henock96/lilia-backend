import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { DriverStatus, IncidentSeverity, IncidentType } from '@prisma/client';

import { NotificationsService } from '../notifications/notifications.service';
import { IncidentsService } from '../incidents/incidents.service';
import { PrismaService } from '../../prisma/prisma.service';
import {
  DeliveryAcceptedEvent,
  DeliveryAssignedEvent,
  DeliveryFailedEvent,
  DeliveryPickedUpEvent,
  DeliveryReadyForPickupEvent,
  DeliveryUnassignedEvent,
} from '../events/delivery-events';

/**
 * Notifications du cycle de vie d'une livraison.
 *
 * Pendant du `OrdersListener`, côté livreur. Avant son introduction, le livreur
 * recevait **une seule** notification sur tout le cycle — « Nouvelle mission » à
 * l'assignation — puis plus rien : ni « la commande est prête », ni « la
 * commande a été annulée », ni « ta mission t'a été retirée ».
 */
@Injectable()
export class DeliveriesListener {
  private readonly logger = new Logger(DeliveriesListener.name);

  constructor(
    private readonly notifications: NotificationsService,
    private readonly incidents: IncidentsService,
    private readonly prisma: PrismaService,
  ) {}

  // ─── ASSIGNATION ───────────────────────────────────────────────────────────

  @OnEvent('delivery.assigned')
  async handleAssigned(event: DeliveryAssignedEvent) {
    const tasks: Promise<unknown>[] = [
      this.notifications.sendPushNotification(
        event.delivererId,
        event.isPreorder && event.scheduledFor
          ? `📅 Pré-commande à récupérer le ${formatScheduledForFr(event.scheduledFor)}`
          : '🚚 Nouvelle mission',
        // Le livreur est souvent assigné dès PAYER, donc avant que le plat soit
        // prêt. On le lui dit au lieu de le laisser deviner.
        event.orderStatus === 'PRET'
          ? `Commande prête chez ${event.restaurantName} — à récupérer`
          : `Commande à récupérer chez ${event.restaurantName} (pas encore prête)`,
        {
          type: 'delivery_assigned',
          deliveryId: event.deliveryId,
          orderId: event.orderId,
          isPreorder: String(event.isPreorder),
          scheduledFor: event.scheduledFor?.toISOString() ?? '',
        },
      ),
    ];

    // Réassignation : l'ancien livreur doit savoir, et surtout être libéré.
    if (
      event.previousDelivererId &&
      event.previousDelivererId !== event.delivererId
    ) {
      tasks.push(
        this.releaseDeliverer(event.previousDelivererId),
        this.notifications.sendPushNotification(
          event.previousDelivererId,
          '↩️ Mission retirée',
          `La course chez ${event.restaurantName} a été confiée à un autre livreur.`,
          {
            type: 'delivery_unassigned',
            deliveryId: event.deliveryId,
            orderId: event.orderId,
          },
        ),
      );
    }

    await Promise.allSettled(tasks);
  }

  // ─── ACCEPTATION ───────────────────────────────────────────────────────────

  /**
   * Le livreur a accepté et part chercher le repas.
   *
   * **Seul le restaurant est prévenu.** C'est lui qui a une information à en
   * tirer : quelqu'un vient chercher la commande, il peut la finaliser et la
   * poser au comptoir. Le client, lui, n'apprend rien d'utile — et lui envoyer
   * « votre livreur est en chemin » ici était précisément le défaut corrigé :
   * le livreur n'a pas encore le repas.
   */
  @OnEvent('delivery.accepted')
  async handleAccepted(event: DeliveryAcceptedEvent) {
    const restaurant = await this.prisma.restaurant.findUnique({
      where: { id: event.restaurantId },
      select: { ownerId: true },
    });
    if (!restaurant) return;

    const shortId = event.orderId.slice(-6).toUpperCase();
    const who = event.delivererName?.trim() || 'Le livreur';

    await this.notifications.sendPushNotification(
      restaurant.ownerId,
      '✅ Livreur en approche',
      `${who} a accepté la mission pour la commande #${shortId} et vient la récupérer.`,
      {
        type: 'delivery_accepted',
        deliveryId: event.deliveryId,
        orderId: event.orderId,
      },
    );
  }

  // ─── REPAS RÉCUPÉRÉ ────────────────────────────────────────────────────────

  /**
   * Le livreur a le repas en main et part vers le client.
   *
   * Le restaurant est informé que la commande a quitté son comptoir. Le client,
   * lui, reçoit son « votre commande est en route » via `order.status.updated`
   * (la commande passe `PRET → EN_ROUTE` au même moment) : on ne le notifie pas
   * deux fois d'ici.
   */
  @OnEvent('delivery.picked_up')
  async handlePickedUp(event: DeliveryPickedUpEvent) {
    const restaurant = await this.prisma.restaurant.findUnique({
      where: { id: event.restaurantId },
      select: { ownerId: true },
    });
    if (!restaurant) return;

    const shortId = event.orderId.slice(-6).toUpperCase();
    const who = event.delivererName?.trim() || 'Le livreur';

    await this.notifications.sendPushNotification(
      restaurant.ownerId,
      '📦 Commande récupérée',
      `${who} a récupéré la commande #${shortId} et part chez le client.`,
      {
        type: 'delivery_picked_up',
        deliveryId: event.deliveryId,
        orderId: event.orderId,
      },
    );
  }

  // ─── COMMANDE PRÊTE ────────────────────────────────────────────────────────

  @OnEvent('delivery.ready_for_pickup')
  async handleReadyForPickup(event: DeliveryReadyForPickupEvent) {
    await this.notifications.sendPushNotification(
      event.delivererId,
      '📦 Commande prête',
      `La commande est prête chez ${event.restaurantName} — tu peux passer la chercher.`,
      {
        type: 'delivery_ready',
        deliveryId: event.deliveryId,
        orderId: event.orderId,
      },
    );
  }

  // ─── ÉCHEC ─────────────────────────────────────────────────────────────────

  /**
   * Un échec ne décide pas du sort de la commande : le vendeur arbitre entre
   * réassigner et annuler. On le prévient (action requise), on informe le
   * client sans lui promettre une issue, et on trace un incident pour qu'une
   * commande oubliée reste visible dans la supervision.
   */
  @OnEvent('delivery.failed')
  async handleFailed(event: DeliveryFailedEvent) {
    const restaurant = await this.prisma.restaurant.findUnique({
      where: { id: event.restaurantId },
      select: { ownerId: true },
    });

    const shortId = event.orderId.slice(-6).toUpperCase();
    const tasks: Promise<unknown>[] = [];

    if (restaurant) {
      tasks.push(
        this.notifications.sendPushNotification(
          restaurant.ownerId,
          '⚠️ Livraison échouée — action requise',
          `Commande #${shortId} : ${event.reason ?? 'la livraison n’a pas abouti'}. ` +
            'Réassignez un livreur ou annulez la commande.',
          {
            type: 'delivery_failed',
            orderId: event.orderId,
            deliveryId: event.deliveryId,
            requiresAction: 'true',
          },
        ),
      );
    }

    // Le client voyait « votre livreur est en chemin » indéfiniment : la
    // commande reste EN_ROUTE tant que le vendeur n'a pas tranché.
    tasks.push(
      this.notifications.sendPushNotification(
        event.userId,
        'Incident de livraison',
        `Votre commande #${shortId} n’a pas pu être livrée. ` +
          'Le vendeur vous recontacte pour trouver une solution.',
        {
          type: 'delivery_failed_customer',
          orderId: event.orderId,
        },
      ),
    );

    if (event.delivererId) {
      tasks.push(this.releaseDeliverer(event.delivererId));
    }

    tasks.push(
      this.incidents
        .create({
          type: IncidentType.DRIVER_NO_SHOW,
          severity: IncidentSeverity.HIGH,
          title: `Livraison échouée #${shortId}`,
          description:
            event.reason ?? 'Échec de livraison — aucune raison fournie.',
          orderId: event.orderId,
          riderId: event.delivererId ?? undefined,
          restaurantId: event.restaurantId,
          metadata: {
            deliveryId: event.deliveryId,
            failedBy: event.failedBy,
          },
        })
        .catch((err: Error) =>
          this.logger.error(`Incident non créé : ${err.message}`),
        ),
    );

    await Promise.allSettled(tasks);
  }

  // ─── LA COMMANDE CHANGE DE STATUT ──────────────────────────────────────────

  /**
   * Deux moments où le livreur assigné doit être prévenu et ne l'était pas.
   *
   * `PRET` : l'assignation est autorisée dès `PAYER`, donc souvent bien avant
   * que le plat soit prêt. Le livreur recevait « Nouvelle mission » puis plus
   * rien — il devait deviner ou appeler le vendeur.
   *
   * `ANNULER` : il se déplaçait pour une commande qui n'existait plus.
   */
  @OnEvent('order.status.updated')
  async handleOrderStatusUpdated(event: {
    orderId: string;
    newStatus: string;
    orderData?: { restaurantName?: string };
  }) {
    if (event.newStatus !== 'PRET') return;

    const delivery = await this.prisma.delivery.findUnique({
      where: { orderId: event.orderId },
      select: {
        id: true,
        delivererId: true,
        status: true,
        order: {
          select: { restaurantId: true, restaurant: { select: { nom: true } } },
        },
      },
    });

    // Personne d'assigné, ou le livreur est déjà parti avec la commande.
    //
    // `ACCEPTER` doit être inclus : depuis la séparation acceptation /
    // récupération, un livreur peut très bien avoir accepté la mission avant
    // que le plat soit prêt (l'assignation est autorisée dès `PAYER`). C'est
    // même le cas le plus fréquent — et c'est lui qui a le plus besoin de
    // savoir qu'il peut passer au comptoir.
    if (
      !delivery?.delivererId ||
      (delivery.status !== 'ASSIGNER' && delivery.status !== 'ACCEPTER')
    ) {
      return;
    }

    await this.handleReadyForPickup(
      new DeliveryReadyForPickupEvent(
        delivery.id,
        event.orderId,
        delivery.order.restaurantId,
        delivery.delivererId,
        delivery.order.restaurant.nom,
      ),
    );
  }

  @OnEvent('order.cancelled')
  async handleOrderCancelled(event: { orderId: string; restaurantId: string }) {
    const delivery = await this.prisma.delivery.findUnique({
      where: { orderId: event.orderId },
      select: { id: true, delivererId: true, status: true },
    });

    // Rien à faire si aucun livreur n'a été mobilisé, ou si la course est déjà
    // terminée (une commande livrée puis annulée pour remboursement).
    if (
      !delivery?.delivererId ||
      delivery.status === 'LIVRER' ||
      delivery.status === 'ECHEC'
    ) {
      return;
    }

    await this.handleUnassigned(
      new DeliveryUnassignedEvent(
        delivery.id,
        event.orderId,
        event.restaurantId,
        delivery.delivererId,
        'order_cancelled',
      ),
    );
  }

  // ─── DÉSASSIGNATION (annulation de la commande) ────────────────────────────

  @OnEvent('delivery.unassigned')
  async handleUnassigned(event: DeliveryUnassignedEvent) {
    if (event.cause !== 'order_cancelled') return; // la réassignation est traitée plus haut

    await Promise.allSettled([
      this.releaseDeliverer(event.delivererId),
      this.notifications.sendPushNotification(
        event.delivererId,
        '❌ Mission annulée',
        `La commande #${event.orderId.slice(-6).toUpperCase()} a été annulée — ne vous déplacez pas.`,
        {
          type: 'delivery_cancelled',
          deliveryId: event.deliveryId,
          orderId: event.orderId,
        },
      ),
    ]);
  }

  /**
   * Repasse un livreur `AVAILABLE`.
   *
   * Conditionnel : on ne libère que s'il est encore `ON_DELIVERY`, pour ne pas
   * réactiver un livreur qui s'est mis `OFFLINE` entre-temps.
   */
  private async releaseDeliverer(delivererId: string): Promise<void> {
    try {
      const released = await this.prisma.user.updateMany({
        where: { id: delivererId, driverStatus: DriverStatus.ON_DELIVERY },
        data: { driverStatus: DriverStatus.AVAILABLE },
      });
      if (released.count > 0) {
        this.logger.log(`Livreur ${delivererId} libéré (AVAILABLE)`);
      }
    } catch (err) {
      this.logger.error(
        `Libération du livreur ${delivererId} échouée : ${(err as Error).message}`,
      );
    }
  }
}

/**
 * `scheduledFor` est stocké en UTC et le serveur Render tourne en UTC.
 * Brazzaville = WAT = UTC+1 : on décale puis on lit les composantes UTC.
 */
export function formatScheduledForFr(d: Date): string {
  const wat = new Date(d.getTime() + 60 * 60 * 1000);
  const days = [
    'dimanche',
    'lundi',
    'mardi',
    'mercredi',
    'jeudi',
    'vendredi',
    'samedi',
  ];
  const months = [
    'janvier',
    'février',
    'mars',
    'avril',
    'mai',
    'juin',
    'juillet',
    'août',
    'septembre',
    'octobre',
    'novembre',
    'décembre',
  ];
  const dayName =
    days[wat.getUTCDay()].charAt(0).toUpperCase() +
    days[wat.getUTCDay()].slice(1);
  const hh = wat.getUTCHours().toString().padStart(2, '0');
  const mm = wat.getUTCMinutes().toString().padStart(2, '0');
  return `${dayName} ${wat.getUTCDate()} ${months[wat.getUTCMonth()]} à ${hh}:${mm}`;
}
