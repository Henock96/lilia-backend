import { Injectable, OnModuleInit } from '@nestjs/common';
import { OrderStatus, OutboxEvent } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { LoyaltyService } from '../loyalty/loyalty.service';
import { ReferralService } from '../users/referral.service';
import { RefundsService } from '../refunds/refunds.service';
import { OutboxService } from './outbox.service';
import { OutboxDispatcherService } from './outbox-dispatcher.service';
import {
  ORDER_DELIVERED_EVENT,
  ORDER_EXPIRED_EVENT,
  ORDER_REFUND_DUE_EVENT,
} from './outbox-events';

/**
 * Traitement des obligations durables nées d'une transition de commande
 * (Master Audit v1, lot 4) : récompenses de livraison, remboursement dû,
 * prévenance d'expiration. Voir `outbox-events.ts`.
 *
 * Inscrit auprès du dispatcher au démarrage plutôt qu'importé par lui : c'est
 * ce qui évite le cycle de modules `Outbox → RefundsCore → PaymentCore →
 * Outbox`.
 */
@Injectable()
export class OrderOutboxEffectsService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
    private readonly dispatcher: OutboxDispatcherService,
    private readonly notifications: NotificationsService,
    private readonly loyalty: LoyaltyService,
    private readonly referral: ReferralService,
    private readonly refunds: RefundsService,
  ) {}

  onModuleInit(): void {
    this.dispatcher.registerHandler(ORDER_DELIVERED_EVENT, (e) =>
      this.dispatchOrderDelivered(e),
    );
    this.dispatcher.registerHandler(ORDER_REFUND_DUE_EVENT, (e) =>
      this.dispatchRefundDue(e),
    );
    this.dispatcher.registerHandler(ORDER_EXPIRED_EVENT, (e) =>
      this.dispatchOrderExpired(e),
    );
  }

  /**
   * Fidélité et parrainage d'une commande livrée — filet durable (lot 4).
   *
   * Le processus web les déclenche déjà juste après le commit ; s'il est mort
   * entre les deux, c'est ici qu'ils sont rattrapés. Les deux effets sont
   * idempotents par contrainte d'unicité : un second passage ne crédite rien.
   * Un échec est une exception : l'obligation reste ouverte et sera rejouée.
   */
  async dispatchOrderDelivered(event: OutboxEvent): Promise<void> {
    const order = await this.prisma.order.findUnique({
      where: { id: event.aggregateId },
      select: { id: true, userId: true, status: true },
    });
    if (!order) {
      await this.outbox.markFailed(event.id, 'Commande introuvable');
      return;
    }
    // Défense en profondeur : une récompense n'existe que pour une commande
    // réellement livrée, quelle que soit la façon dont l'obligation est née.
    if (order.status !== OrderStatus.LIVRER) {
      await this.outbox.markFailed(
        event.id,
        `Commande au statut ${order.status} : aucune récompense de livraison`,
      );
      return;
    }
    await this.loyalty.awardForDeliveredOrder(order.userId, order.id);
    await this.referral.rewardForDeliveredOrder(order.userId, order.id);
    await this.outbox.markSent(event.id);
  }

  /**
   * Ouverture du remboursement d'une commande payée puis annulée.
   *
   * C'était un `.catch(log)` après le commit : si l'ouverture échouait, la
   * dette envers le client n'existait nulle part. `openForCancelledOrder` est
   * idempotent (`Refund @@unique([orderId])`) et ne crée rien si aucun
   * encaissement n'a abouti.
   */
  async dispatchRefundDue(event: OutboxEvent): Promise<void> {
    const payload = (event.payload ?? {}) as {
      reason?: string;
      requestedBy?: string | null;
    };
    const order = await this.prisma.order.findUnique({
      where: { id: event.aggregateId },
      select: { status: true },
    });
    if (!order || order.status !== OrderStatus.ANNULER) {
      await this.outbox.markFailed(
        event.id,
        `Commande ${order ? `au statut ${order.status}` : 'introuvable'} : pas de remboursement à ouvrir`,
      );
      return;
    }
    await this.refunds.openForCancelledOrder({
      orderId: event.aggregateId,
      reason: payload.reason ?? 'Annulation',
      requestedBy: payload.requestedBy ?? null,
    });
    await this.outbox.markSent(event.id);
  }

  /** Prévient le client que sa commande impayée a expiré (F-10). */
  async dispatchOrderExpired(event: OutboxEvent): Promise<void> {
    const order = await this.prisma.order.findUnique({
      where: { id: event.aggregateId },
      select: { id: true, userId: true, status: true },
    });
    if (!order || order.status !== OrderStatus.ANNULER) {
      await this.outbox.markSent(event.id);
      return;
    }
    await this.notifications.sendPushNotification(
      order.userId,
      '⏱️ Commande expirée',
      "Le paiement n'a pas été reçu à temps : votre commande a été annulée. Aucun montant n'a été débité.",
      { orderId: order.id, type: 'order_update', status: 'ANNULER' },
    );
    await this.outbox.markSent(event.id);
  }
}
