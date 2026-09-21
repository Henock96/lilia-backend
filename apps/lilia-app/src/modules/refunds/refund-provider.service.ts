import { Injectable, Logger } from '@nestjs/common';
import {
  PaymentEventKind,
  PaymentEventOutcome,
  PaymentEventSource,
  RefundStatus,
} from '@prisma/client';
import * as Sentry from '@sentry/nestjs';

import { PrismaService } from '../../prisma/prisma.service';
import { PaymentEventService } from '../payments/services/payment-event.service';
import { ProviderTransactionStatus } from '../payments/providers/payment-provider.interface';

/** Issue d'un signal prestataire appliqué à un remboursement. */
export type RefundApplyOutcome =
  | 'APPLIED'
  | 'DUPLICATE'
  | 'IGNORED'
  | 'MISMATCH';

/**
 * Application d'un statut prestataire à un remboursement client.
 *
 * ## Pourquoi c'est un service distinct de `RestaurantPayoutService`
 *
 * Les deux virements sortent par la même route pawaPay (`/payouts`) et portent
 * le même champ `payoutId` — le prestataire ne connaît qu'un type de virement
 * sortant. Mais ils n'ont ni la même table, ni le même bénéficiaire, ni les
 * mêmes conséquences : l'un solde une dette envers un vendeur, l'autre une
 * dette envers un client.
 *
 * Les fondre obligerait chaque requête à filtrer sur un discriminant, et la
 * première qui l'oublierait mélangerait les deux dans un même total — c'est
 * exactement le raisonnement qui a déjà séparé `Payment` de `RestaurantPayout`.
 *
 * ## Les garanties, reprises telles quelles du reversement vendeur
 *
 *  · le journal (`PaymentEvent`) est écrit **avant** toute décision ;
 *  · le montant est contrôlé — un écart n'applique rien et ouvre un incident ;
 *  · la transition est conditionnée sur `status = PROCESSING` : le premier
 *    signal terminal gagne, les suivants sont des doublons sans effet, et un
 *    `FAILED` arrivé après un `COMPLETED` ne peut pas défaire un virement.
 */
@Injectable()
export class RefundProviderService {
  private readonly logger = new Logger(RefundProviderService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: PaymentEventService,
  ) {}

  /** Retrouve un remboursement par sa référence prestataire. */
  async findByProviderRefundId(provider: string, externalId: string) {
    return this.prisma.refund.findFirst({
      where: { provider, providerRefundId: externalId },
      select: { id: true },
    });
  }

  async applyProviderStatus(input: {
    refundId: string;
    status: ProviderTransactionStatus;
    source: PaymentEventSource;
  }): Promise<RefundApplyOutcome> {
    const refund = await this.prisma.refund.findUnique({
      where: { id: input.refundId },
    });
    if (!refund) return 'IGNORED';

    const eventId = await this.events.record({
      kind: PaymentEventKind.PAYOUT,
      provider: refund.provider ?? 'UNKNOWN',
      externalId: refund.providerRefundId ?? refund.id,
      source: input.source,
      rawStatus: input.status.rawStatus,
      payload: input.status.raw,
    });

    if (input.status.state === 'PENDING') {
      await this.events.setOutcome(eventId, PaymentEventOutcome.IGNORED);
      return 'IGNORED';
    }

    // Un prestataire qui confirme un autre montant que celui demandé signale
    // soit son erreur, soit une requête forgée : dans les deux cas on ne
    // conclut rien, et un humain tranche.
    if (
      input.status.amountXaf !== undefined &&
      Math.abs(input.status.amountXaf - refund.amount) > 1
    ) {
      await this.events.setOutcome(eventId, PaymentEventOutcome.MISMATCH);
      this.logger.error(
        `🚨 [REMBOURSEMENT] Incohérence de montant — refund ${refund.id}, ` +
          `attendu ${refund.amount}, reçu ${input.status.amountXaf}`,
      );
      Sentry.captureMessage(
        `refund.mismatch — remboursement ${refund.id}`,
        'error',
      );
      await this.openIncident(
        refund.id,
        refund.orderId,
        `Montant attendu ${refund.amount}, annoncé ${input.status.amountXaf}. Aucune transition appliquée.`,
      );
      return 'MISMATCH';
    }

    const target =
      input.status.state === 'SUCCESS'
        ? RefundStatus.COMPLETED
        : RefundStatus.PENDING;

    const claimed = await this.prisma.refund.updateMany({
      where: { id: refund.id, status: RefundStatus.PROCESSING },
      data: {
        status: target,
        processedAt: target === RefundStatus.COMPLETED ? new Date() : null,
        providerTransactionId: input.status.providerTransactionId ?? null,
        failureCode:
          target === RefundStatus.PENDING
            ? (input.status.failureCode ?? null)
            : null,
        failureMessage:
          target === RefundStatus.PENDING
            ? (input.status.failureMessage ?? null)
            : null,
        // Un échec libère l'identifiant : la reprise en génère un neuf, et
        // l'index unique ne bloque pas une seconde tentative légitime.
        ...(target === RefundStatus.PENDING ? { providerRefundId: null } : {}),
      },
    });

    if (claimed.count === 0) {
      await this.events.setOutcome(eventId, PaymentEventOutcome.DUPLICATE);
      return 'DUPLICATE';
    }

    await this.events.setOutcome(eventId, PaymentEventOutcome.APPLIED);

    if (target === RefundStatus.COMPLETED) {
      this.logger.warn(
        `💸 [REMBOURSEMENT] ✅ ${refund.amount} XAF rendus au client (commande ${refund.orderId})`,
      );
    } else {
      // ⚠️ `PENDING` et non `REJECTED` : `REJECTED` signifie « on refuse de
      // rembourser », une décision métier. Un virement qui échoue est un
      // incident technique — la dette envers le client demeure, et la ligne
      // doit rester dans la file de traitement.
      this.logger.error(
        `💸 [REMBOURSEMENT] ❌ Échec — refund ${refund.id}, code ${input.status.failureCode ?? 'n/a'}. ` +
          'La dette reste ouverte.',
      );
      Sentry.captureMessage(
        `refund.payout_failed — remboursement ${refund.id}`,
        'warning',
      );
    }

    return 'APPLIED';
  }

  private async openIncident(
    refundId: string,
    orderId: string,
    detail: string,
  ): Promise<void> {
    await this.prisma.incident
      .create({
        data: {
          type: 'REFUND_REQUEST',
          severity: 'CRITICAL',
          title: 'Incohérence sur un virement de remboursement',
          description: `${detail} Vérifier auprès du prestataire avant toute action manuelle.`,
          orderId,
          metadata: { refundId },
        },
      })
      .catch((error) =>
        this.logger.error(
          `Incident de remboursement non créé : ${(error as Error).message}`,
        ),
      );
  }
}
