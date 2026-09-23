import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  PaymentEventKind,
  PaymentEventOutcome,
  PaymentEventSource,
  PayoutProvider,
  RefundStatus,
} from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { lockOrderRow } from '../orders/order-row-lock';
import { PaymentProviderRegistry } from '../payments/payment-provider.registry';
import { PaymentEventService } from '../payments/services/payment-event.service';
import { ProviderUnavailableError } from '../payments/providers/payment-provider.interface';
import { maskPhone, maskRef } from '../payments/services/payment.service';

/**
 * Exécution du virement de remboursement au client.
 *
 * ## Ce que ce service change
 *
 * `Refund` était un **registre déclaratif** : un administrateur passait le
 * statut à `COMPLETED` à la main, et rien ne prouvait qu'un franc avait bougé.
 * C'était cohérent avec le mode `MANUAL` d'origine ; ça ne l'était plus depuis
 * que `PawaPayProvider.createPayout` existe et sert aux vendeurs. Un
 * remboursement était le dernier mouvement d'argent sans trace prestataire.
 *
 * ## Pourquoi il calque le reversement vendeur
 *
 * Volontairement, jusque dans l'ordre des opérations. Un second modèle
 * d'idempotence finirait par diverger du premier, et c'est exactement le genre
 * de divergence qui coûte cher sur un flux d'argent — la plateforme a déjà payé
 * le prix de deux résolveurs de commission concurrents.
 *
 * Les quatre garanties reprises telles quelles :
 *
 *  1. `providerRefundId` **généré et persisté AVANT l'appel réseau** — une
 *     reprise rejoue le même identifiant, et le prestataire répond
 *     `DUPLICATE_IGNORED` au lieu de virer une seconde fois ;
 *  2. réservation **conditionnelle** sur le statut lu (`updateMany … WHERE
 *     status = PENDING`) — deux administrateurs simultanés, un seul virement,
 *     et c'est la base qui arbitre ;
 *  3. unicité de `providerRefundId` **en base** (index créé par la migration
 *     `20260921120000_refund_execution`) ;
 *  4. un prestataire injoignable laisse la ligne en `PROCESSING`, **jamais** en
 *     échec : on ne sait pas si la demande est partie, et la marquer ratée
 *     inviterait à réessayer — donc à rembourser deux fois.
 *
 * ## La destination n'est jamais saisie
 *
 * Elle vient de `Payment.phoneNumber`, c'est-à-dire du numéro **depuis lequel
 * le client a payé**. Laisser un administrateur la choisir transformerait cette
 * file en outil de détournement : il suffirait d'annuler une commande et de
 * désigner un autre numéro.
 */
@Injectable()
export class RefundExecutionService {
  private readonly logger = new Logger(RefundExecutionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: PaymentProviderRegistry,
    private readonly events: PaymentEventService,
  ) {}

  async execute(refundId: string, adminUserId: string | null) {
    const refund = await this.prisma.refund.findUnique({
      where: { id: refundId },
      include: {
        payment: true,
        order: { include: { payout: { select: { status: true } } } },
      },
    });
    if (!refund) throw new NotFoundException('Remboursement introuvable.');

    this.assertExecutable(refund);

    const provider = this.registry.forPayout();
    if (!provider) {
      // On refuse plutôt que de marquer `COMPLETED` sans rien envoyer : le mode
      // déclaratif reste accessible par `PATCH /refunds/:id/status`, mais il
      // doit être un geste explicite, pas un repli silencieux.
      throw new BadRequestException(
        `Le mode ${this.registry.currentMode} ne permet pas de rembourser automatiquement. ` +
          'Effectuez le virement à la main, puis clôturez la ligne.',
      );
    }

    const phoneNumber = refund.payment!.phoneNumber;
    const payoutProvider: PayoutProvider =
      refund.payment!.method === 'AIRTEL_MONEY'
        ? PayoutProvider.AIRTEL_MONEY
        : PayoutProvider.MTN_MOMO;
    const providerRefundId = randomUUID();

    // ── Réservation, AVANT tout appel réseau ────────────────────────────────
    // ⚠️ Fix F-04 — la revendication se fait SOUS le verrou de la commande,
    // le même que prend `requestPayout`. `assertExecutable` a lu le reversement
    // hors transaction ; un reversement demandé entre cette lecture et le
    // virement client aurait fait partir les deux. Sous verrou, on relit : un
    // reversement PENDING ou SUCCESS bloque le remboursement (voir
    // `assertNoActivePayout`).
    const claimed = await this.prisma.$transaction(async (tx) => {
      await lockOrderRow(tx, refund.orderId);
      const payout = await tx.restaurantPayout.findUnique({
        where: { orderId: refund.orderId },
        select: { status: true },
      });
      assertNoActivePayout(payout?.status ?? null);
      return tx.refund.updateMany({
        where: { id: refund.id, status: RefundStatus.PENDING },
        data: {
          status: RefundStatus.PROCESSING,
          provider: provider.name,
          providerRefundId,
          phoneNumber,
          payoutProvider,
          processedBy: adminUserId,
          failureCode: null,
          failureMessage: null,
        },
      });
    });
    if (claimed.count === 0) {
      throw new ConflictException(
        'Ce remboursement vient d’être pris en charge. Rechargez la fiche.',
      );
    }

    this.logger.warn(
      `💸 Remboursement client demandé — ${refund.amount} XAF, commande ${refund.orderId}, ` +
        `tel ${maskPhone(phoneNumber)}, ref ${maskRef(providerRefundId)}, par ${adminUserId ?? 'le système (faute vendeur, D2)'}`,
    );

    // ── Appel au prestataire ────────────────────────────────────────────────
    let result;
    try {
      result = await provider.createPayout({
        payoutId: refund.id,
        providerPayoutId: providerRefundId,
        amountXaf: refund.amount,
        currency: 'XAF',
        phoneNumber,
        payoutProvider,
        orderRef: this.orderRef(refund.orderId),
      });
    } catch (error) {
      if (error instanceof ProviderUnavailableError) {
        this.logger.error(
          `💸 Prestataire injoignable au remboursement — refund ${refund.id}. ` +
            'La ligne reste PROCESSING, le cron de réconciliation tranchera.',
        );
        return {
          status: RefundStatus.PROCESSING,
          message:
            'Demande envoyée mais non confirmée par le prestataire. Le statut sera ' +
            'mis à jour automatiquement — ne relancez pas.',
        };
      }
      throw error;
    }

    await this.events.record({
      kind: PaymentEventKind.PAYOUT,
      provider: provider.name,
      externalId: providerRefundId,
      source: PaymentEventSource.INITIATION,
      rawStatus: result.accepted
        ? result.duplicate
          ? 'DUPLICATE_IGNORED'
          : 'ACCEPTED'
        : 'REJECTED',
      payload: result.raw,
      outcome: result.accepted
        ? PaymentEventOutcome.APPLIED
        : PaymentEventOutcome.IGNORED,
    });

    if (!result.accepted) {
      // Refus définitif : la ligne redevient `PENDING` pour qu'un humain
      // corrige (numéro invalide, wallet à sec) et réessaie. On ne la clôt pas
      // en `REJECTED` — ce statut signifie « on refuse de rembourser », une
      // décision métier, pas un incident technique.
      await this.prisma.refund.update({
        where: { id: refund.id },
        data: {
          status: RefundStatus.PENDING,
          failureCode: result.failureCode ?? 'REJECTED',
          failureMessage: result.failureMessage ?? null,
          providerRefundId: null,
        },
      });
      throw new BadRequestException(
        result.failureMessage ??
          'Le prestataire a refusé le virement de remboursement.',
      );
    }

    return {
      status: RefundStatus.PROCESSING,
      message:
        'Virement de remboursement envoyé. Le statut passera à COMPLETED ' +
        'à la confirmation du prestataire.',
    };
  }

  /**
   * Les conditions d'exécution, du plus définitif au plus corrigeable.
   *
   * ⚠️ La dernière est la réciproque d'une règle qui n'existait que dans un
   * sens : `RestaurantPayoutService.checkEligibility` refuse de payer un vendeur
   * tant qu'un remboursement est ouvert. Rien n'empêchait l'inverse — rembourser
   * un client sur une commande dont le vendeur avait déjà été payé, et faire
   * porter les deux à la plateforme.
   */
  private assertExecutable(refund: {
    status: RefundStatus;
    amount: number;
    payment: { status: string; phoneNumber: string } | null;
    order: { payout: { status: string } | null } | null;
  }): void {
    if (refund.status !== RefundStatus.PENDING) {
      throw new ConflictException(
        `Ce remboursement n'est pas en attente (${refund.status}).`,
      );
    }
    if (refund.amount <= 0) {
      throw new BadRequestException('Le montant à rembourser est nul.');
    }
    if (!refund.payment || refund.payment.status !== 'SUCCESS') {
      throw new BadRequestException(
        "Aucun encaissement abouti n'est rattaché à ce remboursement.",
      );
    }
    if (!refund.payment.phoneNumber?.trim()) {
      throw new BadRequestException(
        "Le numéro d'origine du paiement est inconnu : impossible de rembourser " +
          'automatiquement sans risquer de virer au mauvais destinataire.',
      );
    }
    assertNoActivePayout(refund.order?.payout?.status ?? null);
  }

  /** Référence lisible par le client dans son SMS. */
  private orderRef(orderId: string): string {
    return orderId.slice(-8).toUpperCase();
  }
}

/**
 * Invariant F-04 : **jamais deux sorties d'argent pour une même commande.**
 *
 * - reversement `SUCCESS` : le vendeur a l'argent. Rembourser le client ferait
 *   porter les deux montants à la plateforme — arbitrage humain (un incident
 *   « vendeur payé sur une commande annulée » est ouvert à la confirmation).
 * - reversement `PENDING` : l'argent est peut-être déjà parti, et un virement
 *   émis ne se rappelle pas. On attend son issue : `FAILED` libère le
 *   remboursement, `SUCCESS` renvoie au cas précédent.
 * - `FAILED` / `CANCELLED` / aucun : le vendeur n'a rien reçu, on rembourse.
 */
export function assertNoActivePayout(payoutStatus: string | null): void {
  if (payoutStatus === 'SUCCESS') {
    throw new ConflictException(
      'Le vendeur a déjà été reversé pour cette commande. Rembourser le client ' +
        'ferait porter les deux montants à la plateforme — arbitrage manuel requis.',
    );
  }
  if (payoutStatus === 'PENDING') {
    throw new ConflictException(
      'Un reversement au vendeur est en cours pour cette commande. Attendez son ' +
        'issue : un échec libérera le remboursement, un succès demandera un arbitrage.',
    );
  }
}
