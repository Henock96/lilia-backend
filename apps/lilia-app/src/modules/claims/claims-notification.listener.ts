import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { MessageVisibility, Role } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import type { ClaimResolvedEvent } from '../refunds/refund-composer.service';
import {
  CLAIM_MESSAGE_POSTED_EVENT,
  CLAIM_OPENED_EVENT,
  type ClaimMessagePostedEvent,
  type ClaimOpenedEvent,
} from './claims.service';

const fmt = (n: number) => `${n.toLocaleString('fr-FR')} FCFA`;
const ref = (orderId: string) => orderId.slice(-8).toUpperCase();

/**
 * Notifications des réclamations (F3-06).
 *
 * Les trois gestes naissent d'une requête HTTP, donc dans le processus web :
 * un listener en mémoire suffit (le worker n'en a aucun, mais il ne produit
 * aucun de ces événements). Un push perdu ne perd rien : la demande et son
 * fil restent lisibles dans « Mes demandes ».
 *
 * Les administrateurs ne sont pas notifiés ici : `incident.created` les
 * prévient déjà, et la file « Réclamations » du cockpit porte le délai.
 */
@Injectable()
export class ClaimsNotificationListener {
  private readonly logger = new Logger(ClaimsNotificationListener.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  @OnEvent(CLAIM_OPENED_EVENT)
  async onOpened(event: ClaimOpenedEvent): Promise<void> {
    await this.safe(async () => {
      const ownerId = await this.ownerOf(event.restaurantId);
      if (!ownerId) return;
      await this.notifications.sendPushNotification(
        ownerId,
        `Réclamation sur la commande #${ref(event.orderId)}`,
        event.summary,
        {
          type: 'claim_opened',
          claimId: event.incidentId,
          orderId: event.orderId,
        },
      );
    });
  }

  @OnEvent(CLAIM_MESSAGE_POSTED_EVENT)
  async onMessage(event: ClaimMessagePostedEvent): Promise<void> {
    await this.safe(async () => {
      const data = {
        type: 'claim_message',
        claimId: event.incidentId,
        orderId: event.orderId,
      };
      // Le support ou le vendeur écrit au client : seul un message visible de
      // lui mérite de le déranger.
      if (
        event.authorRole === Role.ADMIN &&
        event.visibility === MessageVisibility.ALL
      ) {
        await this.notifications.sendPushNotification(
          event.userId,
          'Réponse du service client',
          `Nouveau message sur votre demande (commande #${ref(event.orderId)}).`,
          data,
        );
      }
      // Le support s'adresse au vendeur seul : il attend sa version.
      if (
        event.authorRole === Role.ADMIN &&
        event.visibility === MessageVisibility.STAFF_ONLY
      ) {
        const ownerId = await this.ownerOf(event.restaurantId);
        if (ownerId) {
          await this.notifications.sendPushNotification(
            ownerId,
            'Le service client vous écrit',
            `Réclamation sur la commande #${ref(event.orderId)}.`,
            data,
          );
        }
      }
    });
  }

  @OnEvent('claim.resolved')
  async onResolved(event: ClaimResolvedEvent): Promise<void> {
    await this.safe(async () => {
      const data = {
        type: 'claim_resolved',
        claimId: event.incidentId,
        orderId: event.orderId,
      };
      const client =
        event.outcome === 'REFUNDED'
          ? `${fmt(event.amountXaf)} vous sont remboursés sur votre Mobile Money.`
          : event.outcome === 'VOUCHER'
            ? `Un avoir de ${fmt(event.amountXaf)} vous attend : ouvrez votre demande pour le code.`
            : 'Votre demande a été examinée : ouvrez-la pour voir la réponse.';
      await this.notifications.sendPushNotification(
        event.userId,
        `Votre demande — commande #${ref(event.orderId)}`,
        client,
        data,
      );

      const ownerId = await this.ownerOf(event.restaurantId);
      if (!ownerId) return;
      const vendor =
        event.outcome === 'REFUNDED' && event.bearer === 'VENDOR'
          ? `${fmt(event.amountXaf)} seront déduits de votre prochain reversement.`
          : 'La réclamation est traitée, sans impact sur votre reversement.';
      await this.notifications.sendPushNotification(
        ownerId,
        `Réclamation #${ref(event.orderId)} traitée`,
        vendor,
        data,
      );
    });
  }

  private async ownerOf(restaurantId: string): Promise<string | null> {
    const r = await this.prisma.restaurant.findUnique({
      where: { id: restaurantId },
      select: { ownerId: true },
    });
    return r?.ownerId ?? null;
  }

  private async safe(fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (error) {
      this.logger.warn(
        `Notification de réclamation non envoyée : ${(error as Error).message}`,
      );
    }
  }
}
