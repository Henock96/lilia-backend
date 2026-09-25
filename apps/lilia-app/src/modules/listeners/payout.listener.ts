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

  // ⚠️ `payout.succeeded` / `payout.failed` ne sont PLUS écoutés ici (F3-07) :
  // ils sont écrits dans l'outbox avec la transition du versement et dépilés
  // par `PayoutOutboxEffectsService` — c'est le plus souvent le worker qui
  // conclut un versement, et il n'a aucun écouteur.

  /**
   * Encaissement abouti sur une commande qui n'attend plus de paiement.
   *
   * ⚠️ **L'incident n'est plus ouvert ici** (audit du 21/09/2026).
   * `PaymentService.openOrphanIncident` s'en charge, pour une raison de
   * portée : `applyCollectionProviderStatus` tourne aussi dans le **worker**,
   * dont le graphe de modules ne contient aucun listener. Un orphelin détecté
   * par le cron de réconciliation n'ouvrait donc aucun incident — exactement le
   * cas où personne ne regarde, puisque aucun humain n'a déclenché l'appel.
   *
   * Le handler est conservé pour la seule trace applicative : l'événement reste
   * le point d'accroche naturel pour tout ce qu'on voudra brancher ensuite
   * (relance support, message au client), sans rouvrir la question de savoir
   * qui écrit l'incident.
   */
  @OnEvent('payment.orphaned')
  handleOrphanedPayment(event: {
    orderId: string;
    paymentId: string;
    amount: number;
  }) {
    this.logger.error(
      `🚨 Encaissement orphelin — ${Math.round(event.amount)} FCFA sur la commande ` +
        `${event.orderId} (paiement ${event.paymentId}). Incident ouvert par PaymentService.`,
    );
  }
}
