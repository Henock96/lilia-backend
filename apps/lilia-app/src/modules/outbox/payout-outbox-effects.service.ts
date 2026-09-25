import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { OutboxEvent } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { OutboxService } from './outbox.service';
import { OutboxDispatcherService } from './outbox-dispatcher.service';
import { PAYOUT_FAILED_EVENT, PAYOUT_SUCCEEDED_EVENT } from './outbox-events';

/** Charge utile écrite par `RestaurantPayoutService` avec la transition. */
export interface PayoutOutboxPayload {
  payoutId: string;
  orderId: string;
  restaurantId: string;
  /** `User.id` du propriétaire du vendeur — destinataire du push. */
  ownerId: string;
  amount: number;
  /** Dette de remboursement retenue sur ce versement (F3-07). */
  debtDeductionAmount?: number;
  reason?: string | null;
}

/**
 * Notifications de versement au vendeur (F3-07).
 *
 * Elles vivaient dans `PayoutListener` (`@OnEvent`). Or ce sont surtout le
 * worker — réconciliation toutes les 2 min, versement automatique — qui
 * concluent un versement, et le worker n'a **aucun écouteur** : un vendeur
 * payé par la réconciliation n'était jamais prévenu. L'obligation est
 * désormais écrite dans la transaction du versement, et dépilée ici.
 *
 * Un seul destinataire : le vendeur. Le client n'a rien à savoir de ce qui se
 * passe entre Lilia Food et le commerçant.
 */
@Injectable()
export class PayoutOutboxEffectsService implements OnModuleInit {
  private readonly logger = new Logger(PayoutOutboxEffectsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
    private readonly dispatcher: OutboxDispatcherService,
    private readonly notifications: NotificationsService,
  ) {}

  onModuleInit(): void {
    this.dispatcher.registerHandler(PAYOUT_SUCCEEDED_EVENT, (e) =>
      this.dispatchSucceeded(e),
    );
    this.dispatcher.registerHandler(PAYOUT_FAILED_EVENT, (e) =>
      this.dispatchFailed(e),
    );
  }

  async dispatchSucceeded(event: OutboxEvent): Promise<void> {
    const p = event.payload as unknown as PayoutOutboxPayload;
    const ref = p.orderId.slice(-6).toUpperCase();
    const debt = p.debtDeductionAmount ?? 0;
    const body =
      p.amount === 0
        ? `La commande #${ref} a réglé ${Math.round(debt)} FCFA de remboursement client dû : aucun virement pour cette commande.`
        : `Votre paiement de ${Math.round(p.amount)} FCFA pour la commande #${ref} a été effectué.` +
          (debt > 0
            ? ` ${Math.round(debt)} FCFA de remboursement client ont été retenus.`
            : '');
    await this.notifications.sendPushNotification(
      p.ownerId,
      '💰 Paiement reçu',
      body,
      {
        orderId: p.orderId,
        payoutId: p.payoutId,
        type: 'payout_succeeded',
        amount: String(Math.round(p.amount)),
      },
    );
    await this.outbox.markSent(event.id);
    this.logger.log(
      `📱 Vendeur ${p.ownerId} notifié du versement ${p.payoutId}`,
    );
  }

  /**
   * Échec : le vendeur est prévenu **sans le motif technique** (un
   * « PAWAPAY_WALLET_OUT_OF_FUNDS » est un problème de trésorerie de Lilia,
   * pas le sien) ; l'administration a un incident avec le motif complet.
   * L'incident est dédoublonné par versement : un rejeu n'en ouvre pas deux.
   */
  async dispatchFailed(event: OutboxEvent): Promise<void> {
    const p = event.payload as unknown as PayoutOutboxPayload;
    const ref = p.orderId.slice(-6).toUpperCase();
    await this.notifications.sendPushNotification(
      p.ownerId,
      '⚠️ Paiement en attente',
      `Le versement de ${Math.round(p.amount)} FCFA pour la commande #${ref} n'a pas abouti. Lilia Food le relance ; aucune action de votre part.`,
      { orderId: p.orderId, payoutId: p.payoutId, type: 'payout_failed' },
    );
    const dedupKey = `payout_failed:${p.payoutId}`;
    const existing = await this.prisma.incident.findFirst({
      where: { dedupKey },
      select: { id: true },
    });
    if (!existing) {
      await this.prisma.incident.create({
        data: {
          type: 'OTHER',
          severity: 'HIGH',
          title: 'Reversement vendeur en échec',
          description:
            `Le reversement de ${Math.round(p.amount)} FCFA pour la commande ${p.orderId} ` +
            `a échoué${p.reason ? ` : ${p.reason}` : ''}. ` +
            `Vérifier le compte Mobile Money du vendeur, puis réessayer depuis l'administration.`,
          orderId: p.orderId,
          restaurantId: p.restaurantId,
          dedupKey,
          metadata: { payoutId: p.payoutId, reason: p.reason ?? null },
        },
      });
    }
    await this.outbox.markSent(event.id);
  }
}
