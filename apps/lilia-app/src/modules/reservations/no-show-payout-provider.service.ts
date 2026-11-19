import { Injectable, Logger } from '@nestjs/common';
import {
  PaymentEventKind,
  PaymentEventOutcome,
  PaymentEventSource,
  Prisma,
  ReservationNoShowPayout,
} from '@prisma/client';
import * as Sentry from '@sentry/nestjs';

import { PrismaService } from '../../prisma/prisma.service';
import { OutboxService } from '../outbox/outbox.service';
import { ProviderTransactionStatus } from '../payments/providers/payment-provider.interface';
import {
  guardSignalOutcome,
  PaymentEventService,
} from '../payments/services/payment-event.service';
import { enqueueReservationNotice } from './reservation-notices';

/** Issue d'un signal prestataire appliqué à un versement d'absence. */
export type NoShowPayoutApplyOutcome =
  | 'APPLIED'
  | 'DUPLICATE'
  | 'IGNORED'
  | 'MISMATCH';

/**
 * 4B-2 J6b — issue d'un versement de part d'absence, par le webhook pawaPay
 * ou la réconciliation : **un seul chemin** pour les deux.
 *
 * Mêmes garanties que `RefundProviderService` :
 *  · le journal (`PaymentEvent`) est écrit avant toute décision ;
 *  · montant ET devise contrôlés (P-3) — un écart n'applique rien et ouvre
 *    un incident ;
 *  · transition conditionnée sur `status = PENDING` : le premier signal
 *    terminal gagne, `SUCCESS` et `FAILED` sont figés.
 *
 * Le restaurant est prévenu à l'aboutissement, par l'outbox, dans la même
 * transaction que la transition (règle 11). Le grand livre écrit le
 * versement à son passage (`LedgerPosterService.passNoShowPayouts`).
 */
@Injectable()
export class NoShowPayoutProviderService {
  private readonly logger = new Logger(NoShowPayoutProviderService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: PaymentEventService,
    private readonly outbox: OutboxService,
  ) {}

  /** Retrouve un versement d'absence par sa référence prestataire. */
  async findByProviderPayoutId(provider: string, externalId: string) {
    return this.prisma.reservationNoShowPayout.findFirst({
      where: { provider, providerPayoutId: externalId },
      select: { id: true },
    });
  }

  async applyProviderStatus(input: {
    payoutId: string;
    status: ProviderTransactionStatus;
    source: PaymentEventSource;
  }): Promise<NoShowPayoutApplyOutcome> {
    const payout = await this.prisma.reservationNoShowPayout.findUnique({
      where: { id: input.payoutId },
    });
    if (!payout) return 'IGNORED';

    const eventId = await this.events.record({
      kind: PaymentEventKind.PAYOUT,
      provider: payout.provider,
      externalId: payout.providerPayoutId,
      source: input.source,
      rawStatus: input.status.rawStatus,
      payload: input.status.raw,
    });

    return guardSignalOutcome(this.events, eventId, () =>
      this.applyRecordedStatus(payout, input.status, eventId),
    );
  }

  private async applyRecordedStatus(
    payout: ReservationNoShowPayout,
    status: ProviderTransactionStatus,
    eventId: string | null,
  ): Promise<NoShowPayoutApplyOutcome> {
    if (status.state === 'PENDING') {
      await this.events.setOutcome(eventId, PaymentEventOutcome.IGNORED);
      return 'IGNORED';
    }

    const mismatch = this.mismatch(status, payout);
    if (mismatch) {
      await this.events.setOutcome(eventId, PaymentEventOutcome.MISMATCH);
      this.logger.error(
        `🚨 [PART D’ABSENCE] Incohérence — versement ${payout.id} : ${mismatch}`,
      );
      Sentry.captureMessage(
        `no_show_payout.mismatch — versement ${payout.id}`,
        'error',
      );
      await this.openIncident(payout, mismatch);
      return 'MISMATCH';
    }

    const success = status.state === 'SUCCESS';
    const moved = await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.reservationNoShowPayout.updateMany({
        where: { id: payout.id, status: 'PENDING' },
        data: success
          ? {
              status: 'SUCCESS',
              completedAt: new Date(),
              providerTransactionId: status.providerTransactionId ?? null,
            }
          : {
              status: 'FAILED',
              failureCode: status.failureCode ?? null,
              failureMessage: status.failureMessage ?? null,
            },
      });
      if (claimed.count > 0 && success) {
        const settlement =
          await tx.reservationNoShowSettlement.findUniqueOrThrow({
            where: { id: payout.settlementId },
            select: {
              reservation: {
                select: { id: true, arrivalAt: true, partySize: true },
              },
              restaurant: { select: { nom: true, ownerId: true } },
            },
          });
        await enqueueReservationNotice(tx, this.outbox, {
          notice: 'NO_SHOW_SHARE_PAID',
          audience: 'VENDOR',
          recipientUserId: settlement.restaurant.ownerId,
          restaurantName: settlement.restaurant.nom,
          reservationId: settlement.reservation.id,
          arrivalAt: settlement.reservation.arrivalAt.toISOString(),
          partySize: settlement.reservation.partySize,
          payoutXaf: payout.amountXaf,
        });
      }
      return claimed.count;
    });

    if (moved === 0) {
      await this.events.setOutcome(eventId, PaymentEventOutcome.DUPLICATE);
      return 'DUPLICATE';
    }
    await this.events.setOutcome(eventId, PaymentEventOutcome.APPLIED);

    if (success) {
      this.logger.warn(
        `💸 [PART D’ABSENCE] ✅ ${payout.amountXaf} XAF versés au restaurant ${payout.restaurantId}`,
      );
    } else {
      // La part reste due : une nouvelle demande (deux administrateurs)
      // devient possible, l'échec reste en historique.
      this.logger.error(
        `💸 [PART D’ABSENCE] ❌ Échec — versement ${payout.id}, code ${status.failureCode ?? 'n/a'}. ` +
          'La part reste due.',
      );
      Sentry.captureMessage(
        `no_show_payout.failed — versement ${payout.id}`,
        'warning',
      );
    }
    return 'APPLIED';
  }

  /**
   * Montant ou devise différents de ce qui a été envoyé (P-3). Égalité stricte
   * en entiers XAF (règle 5) ; un aboutissement doit ANNONCER les deux — un
   * `SUCCESS` muet sur le montant ou la devise ne solde rien. pawaPay les
   * renseigne au callback comme à l'interrogation (`pawapay.mapper.ts`).
   */
  private mismatch(
    status: ProviderTransactionStatus,
    payout: { amountXaf: number },
  ): string | null {
    if (status.state === 'SUCCESS') {
      if (status.currency === undefined) return 'devise non annoncée';
      if (status.amountXaf === undefined) return 'montant non annoncé';
    }
    if (status.currency !== undefined && status.currency !== 'XAF') {
      return `devise attendue XAF, reçue ${status.currency}`;
    }
    if (
      status.amountXaf !== undefined &&
      status.amountXaf !== payout.amountXaf
    ) {
      return `montant attendu ${payout.amountXaf}, annoncé ${status.amountXaf}`;
    }
    return null;
  }

  private async openIncident(
    payout: ReservationNoShowPayout,
    detail: string,
  ): Promise<void> {
    await this.prisma.incident
      .create({
        data: {
          type: 'OTHER',
          severity: 'CRITICAL',
          title: 'Incohérence sur le versement d’une part d’absence',
          description:
            `${detail}. Aucune transition appliquée. ` +
            'Vérifier auprès du prestataire avant toute action manuelle.',
          restaurantId: payout.restaurantId,
          // Un seul incident ouvert par versement : la ligne reste PENDING et
          // la réconciliation la rejoue toutes les 2 minutes.
          dedupKey: `no_show_payout:${payout.id}:mismatch`,
          metadata: {
            noShowPayoutId: payout.id,
            settlementId: payout.settlementId,
          },
        },
      })
      .catch((error: unknown) => {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2002'
        ) {
          return; // déjà ouvert (`Incident_dedupKey_open_uq`)
        }
        this.logger.error(
          `Incident de part d’absence non créé : ${(error as Error).message}`,
        );
      });
  }
}
