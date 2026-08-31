import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';

import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../../prisma/prisma.service';

export interface PayoutSucceededEvent {
  payoutId: string;
  orderId: string;
  restaurantId: string;
  /** `User.id` du propriétaire du vendeur — destinataire du push. */
  ownerId: string;
  amount: number;
}

export interface PayoutFailedEvent extends PayoutSucceededEvent {
  reason?: string;
}

/**
 * Notifications liées au reversement d'un vendeur.
 *
 * Un seul destinataire : **le vendeur**. Le client n'a rien à savoir de ce qui
 * se passe entre Lilia Food et le commerçant — ni la commission, ni le montant
 * reversé, ni les frais du prestataire. C'est une information commerciale
 * interne, et l'exposer inviterait à des comparaisons entre vendeurs qui ne
 * regardent personne.
 *
 * Deux messages seulement, et jamais les deux pour un même reversement : les
 * transitions sont conditionnées sur `PENDING`, donc un seul état terminal est
 * atteint.
 */
@Injectable()
export class PayoutListener {
  private readonly logger = new Logger(PayoutListener.name);

  constructor(
    private readonly notifications: NotificationsService,
    private readonly prisma: PrismaService,
  ) {}

  @OnEvent('payout.succeeded')
  async handlePayoutSucceeded(event: PayoutSucceededEvent) {
    try {
      const ref = event.orderId.slice(-6).toUpperCase();
      await this.notifications.sendPushNotification(
        event.ownerId,
        '💰 Paiement reçu',
        `Votre paiement de ${Math.round(event.amount)} FCFA pour la commande #${ref} a été effectué.`,
        {
          orderId: event.orderId,
          payoutId: event.payoutId,
          type: 'payout_succeeded',
          amount: String(Math.round(event.amount)),
        },
      );
      this.logger.log(
        `📱 Vendeur ${event.ownerId} notifié du reversement ${event.payoutId}`,
      );
    } catch (error) {
      this.logger.error(
        `Notification de reversement échouée (${event.payoutId}) : ${(error as Error).message}`,
      );
    }
  }

  /**
   * Échec de reversement.
   *
   * Le vendeur est prévenu **sans le motif technique** : « PAYER_LIMIT_REACHED »
   * ou « PAWAPAY_WALLET_OUT_OF_FUNDS » ne lui apprennent rien d'actionnable, et
   * le second est un problème de trésorerie de Lilia Food qui ne le concerne
   * pas. Le motif complet reste dans `RestaurantPayout.failureCode` et dans le
   * journal, à destination de l'administration.
   *
   * Un incident est ouvert : un vendeur non payé qui n'apparaîtrait nulle part
   * en supervision finirait par appeler le support, ce qui est le signal le plus
   * cher qui soit.
   */
  @OnEvent('payout.failed')
  async handlePayoutFailed(event: PayoutFailedEvent) {
    try {
      const ref = event.orderId.slice(-6).toUpperCase();
      await this.notifications.sendPushNotification(
        event.ownerId,
        '⚠️ Paiement en attente',
        `Le versement de ${Math.round(event.amount)} FCFA pour la commande #${ref} n'a pas abouti. Lilia Food le relance ; aucune action de votre part.`,
        {
          orderId: event.orderId,
          payoutId: event.payoutId,
          type: 'payout_failed',
        },
      );

      await this.prisma.incident.create({
        data: {
          type: 'OTHER',
          severity: 'HIGH',
          title: 'Reversement vendeur en échec',
          description:
            `Le reversement de ${Math.round(event.amount)} FCFA pour la commande ${event.orderId} ` +
            `a échoué${event.reason ? ` : ${event.reason}` : ''}. ` +
            `Vérifier le compte Mobile Money du vendeur, puis réessayer depuis l'administration.`,
          orderId: event.orderId,
          restaurantId: event.restaurantId,
          metadata: { payoutId: event.payoutId, reason: event.reason ?? null },
        },
      });
    } catch (error) {
      this.logger.error(
        `Traitement de payout.failed échoué (${event.payoutId}) : ${(error as Error).message}`,
      );
    }
  }

  /**
   * Encaissement abouti sur une commande qui n'attend plus de paiement.
   *
   * Ce n'est pas un cas nominal : de l'argent est entré pour une commande
   * expirée ou annulée. On ouvre un incident CRITICAL — c'est une dette envers
   * le client, et elle doit être visible sans que personne n'ait à lire les logs.
   */
  @OnEvent('payment.orphaned')
  async handleOrphanedPayment(event: {
    orderId: string;
    paymentId: string;
    amount: number;
  }) {
    await this.prisma.incident
      .create({
        data: {
          type: 'REFUND_REQUEST',
          severity: 'CRITICAL',
          title: 'Encaissement sur une commande non payable',
          description:
            `Un paiement de ${Math.round(event.amount)} FCFA a été confirmé sur la commande ` +
            `${event.orderId}, qui n'était plus en attente de paiement (expirée ou annulée). ` +
            `L'argent est encaissé, la commande ne sera pas honorée : ouvrir un remboursement.`,
          orderId: event.orderId,
          metadata: { paymentId: event.paymentId, amount: event.amount },
        },
      })
      .catch((error) =>
        this.logger.error(
          `Incident d'encaissement orphelin non créé : ${(error as Error).message}`,
        ),
      );
  }
}
