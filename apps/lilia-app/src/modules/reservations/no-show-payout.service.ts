import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  ApprovalKind,
  ApprovalStatus,
  FinancialApproval,
  PaymentEventKind,
  PaymentEventOutcome,
  PaymentEventSource,
  Prisma,
  ReservationNoShowPayout,
} from '@prisma/client';
import * as Sentry from '@sentry/nestjs';

import { PrismaService } from '../../prisma/prisma.service';
import { consumeApproval } from '../approvals/approval-rules';
import { lockOrderRow } from '../orders/order-row-lock';
import { PaymentProviderRegistry } from '../payments/payment-provider.registry';
import {
  InitiateResult,
  ProviderUnavailableError,
} from '../payments/providers/payment-provider.interface';
import { PaymentEventService } from '../payments/services/payment-event.service';
import { maskPhone, maskRef } from '../payments/services/payment.service';
import {
  ACTIVE_NO_SHOW_PAYOUT_STATUSES,
  assertNoShowPayoutAccountUsable,
  NoShowPayoutApprovalPayload,
  noShowPayoutApprovalPayload,
  NoShowPayoutState,
  noShowPayoutState,
  sameNoShowPayoutPayload,
} from './no-show-payout.policy';

/** Ce que lit une demande ou une validation : la part et le compte. */
const SETTLEMENT_SELECT = {
  id: true,
  orderId: true,
  restaurantId: true,
  vendorShareXaf: true,
  restaurant: {
    select: {
      nom: true,
      payoutPhoneNumber: true,
      payoutProvider: true,
      payoutVerifiedAt: true,
    },
  },
} satisfies Prisma.ReservationNoShowSettlementSelect;

/**
 * 4B-2 J6b — versement de la part restaurant d'une absence
 * (`16-J6b-design.md`).
 *
 * ## Pourquoi un chemin dédié
 *
 * `RestaurantPayoutService` verse **une commande livrée**, sur preuve
 * (`payoutDueAt`), et refuse une commande annulée. Une absence n'est ni
 * l'un ni l'autre : la réutiliser imposerait de contourner ses contrôles, ce
 * que le relevé du 21/10 interdit. Ce service calque le **remboursement
 * client** (`RefundExecutionService`), jusque dans l'ordre des opérations :
 *
 *  1. ligne `PENDING` avec `providerPayoutId` **généré et écrit avant**
 *     l'appel réseau — un rejeu rejoue le même identifiant ;
 *  2. décision sous le verrou de la commande (`lockOrderRow`, F-04), et
 *     approbation consommée dans la même transaction ;
 *  3. au plus un versement en cours ou abouti par absence : index unique
 *     partiel en base, pas seulement ce service ;
 *  4. prestataire injoignable : la ligne reste `PENDING`, la réconciliation
 *     tranche — jamais un échec supposé, qui inviterait à payer deux fois.
 *
 * ## Toujours à deux
 *
 * Aucun seuil : la demande (`FINANCE_EXECUTE`) ouvre une approbation, le
 * virement part à la validation d'un second administrateur
 * (`FINANCE_APPROVE` + MFA). Le numéro et l'opérateur sont dans la demande ;
 * s'ils ont changé à la validation, rien ne part (P-2).
 */
@Injectable()
export class NoShowPayoutService {
  private readonly logger = new Logger(NoShowPayoutService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: PaymentProviderRegistry,
    private readonly events: PaymentEventService,
  ) {}

  /**
   * Contrôles de la demande, et ce que l'approbation autorisera. N'écrit rien :
   * le contrôleur ouvre l'approbation (`ApprovalsService.request`).
   */
  async prepareRequest(settlementId: string, now = new Date()) {
    const settlement = await this.prisma.reservationNoShowSettlement.findUnique(
      { where: { id: settlementId }, select: SETTLEMENT_SELECT },
    );
    if (!settlement) throw new NotFoundException('Absence introuvable.');
    if (settlement.vendorShareXaf <= 0) {
      throw new ConflictException({
        message: 'Aucune part n’est due au restaurant pour cette absence.',
        code: 'NO_SHOW_PAYOUT_NOTHING_DUE',
      });
    }
    await this.assertNoActivePayout(this.prisma, settlementId);
    const account = settlement.restaurant;
    assertNoShowPayoutAccountUsable(
      account,
      now,
      await this.accountChangePending(this.prisma, settlement.restaurantId),
    );
    const payload = noShowPayoutApprovalPayload(settlement, account);
    return {
      payload,
      amountXaf: settlement.vendorShareXaf,
      summary:
        `Part d’absence de ${settlement.vendorShareXaf} FCFA pour ${account.nom} ` +
        `(${account.payoutProvider} ${maskPhone(account.payoutPhoneNumber)}, ` +
        `commande #${settlement.orderId.slice(-6).toUpperCase()})`,
    };
  }

  /**
   * Exécute une demande approuvée. Appelé par `ApprovalsService.approve`
   * **hors** de la transaction qui marque l'approbation (P-1) : l'appel au
   * prestataire ne part jamais depuis une transaction ouverte.
   */
  async execute(approval: FinancialApproval, approverId: string) {
    if (approval.kind !== ApprovalKind.NO_SHOW_VENDOR_SHARE_PAYOUT) {
      throw new ConflictException({
        message: 'Cette approbation ne vise pas un versement d’absence.',
        code: 'APPROVAL_NOT_USABLE',
      });
    }
    const provider = this.registry.forPayout();
    if (!provider) {
      // Refusé AVANT de consommer l'approbation : le même valideur pourra
      // relancer une fois le mode de paiement rétabli.
      throw new BadRequestException(
        `Le mode ${this.registry.currentMode} ne permet pas de verser automatiquement.`,
      );
    }
    const approved = approval.payload as unknown as NoShowPayoutApprovalPayload;
    const providerPayoutId = randomUUID();

    // ── Réservation, AVANT tout appel réseau ────────────────────────────────
    let row: ReservationNoShowPayout;
    try {
      row = await this.prisma.$transaction(async (tx) => {
        const settlement = await tx.reservationNoShowSettlement.findUnique({
          where: { id: approval.refId },
          select: SETTLEMENT_SELECT,
        });
        if (!settlement) throw new NotFoundException('Absence introuvable.');
        await lockOrderRow(tx, settlement.orderId);
        await this.assertNoActivePayout(tx, settlement.id);

        const account = settlement.restaurant;
        assertNoShowPayoutAccountUsable(
          account,
          new Date(),
          await this.accountChangePending(tx, settlement.restaurantId),
        );
        const current = noShowPayoutApprovalPayload(settlement, account);
        if (!sameNoShowPayoutPayload(current, approved)) {
          throw new ConflictException({
            message:
              'Le compte de versement ou le montant a changé depuis la demande. ' +
              'Rien n’est parti : refaites une demande.',
            code: 'NO_SHOW_PAYOUT_ACCOUNT_CHANGED',
          });
        }
        await consumeApproval(tx, {
          approvalId: approval.id,
          kind: ApprovalKind.NO_SHOW_VENDOR_SHARE_PAYOUT,
          refId: settlement.id,
          payload: current,
        });
        return tx.reservationNoShowPayout.create({
          data: {
            settlementId: settlement.id,
            restaurantId: settlement.restaurantId,
            amountXaf: current.amountXaf,
            phoneNumber: current.phoneNumber,
            payoutProvider: current.payoutProvider,
            provider: provider.name,
            providerPayoutId,
            requestedBy: approval.requestedBy,
            approvedBy: approverId,
            approvalId: approval.id,
          },
        });
      });
    } catch (error) {
      // L'index partiel a tranché entre deux exécutions simultanées.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException({
          message:
            'Un versement est déjà en cours ou abouti pour cette absence.',
          code: 'NO_SHOW_PAYOUT_ALREADY_ACTIVE',
        });
      }
      throw error;
    }

    this.logger.warn(
      `💸 Part d’absence demandée — ${row.amountXaf} XAF, absence ${row.settlementId}, ` +
        `tel ${maskPhone(row.phoneNumber)}, ref ${maskRef(providerPayoutId)}, ` +
        `demandé par ${row.requestedBy}, validé par ${approverId}`,
    );

    // ── Appel au prestataire ────────────────────────────────────────────────
    let result: InitiateResult;
    try {
      result = await provider.createPayout({
        payoutId: row.id,
        providerPayoutId,
        amountXaf: row.amountXaf,
        currency: 'XAF',
        phoneNumber: row.phoneNumber,
        payoutProvider: row.payoutProvider,
        orderRef: approval.refId.slice(-8).toUpperCase(),
      });
    } catch (error) {
      // La ligne est réservée et l'approbation consommée : quelle que soit
      // l'erreur, on ne sait pas si le virement est parti. Un 500 laisserait
      // croire que rien n'a bougé ; la réconciliation tranche.
      if (!(error instanceof ProviderUnavailableError)) {
        Sentry.captureException(error, {
          tags: { flow: 'no_show_payout', noShowPayoutId: row.id },
        });
      }
      this.logger.error(
        `💸 Issue inconnue à l’envoi du versement d’absence ${row.id} ` +
          `(${(error as Error).message}). La ligne reste PENDING, la réconciliation tranchera.`,
      );
      return {
        payoutId: row.id,
        status: 'PENDING' as const,
        message:
          'Demande envoyée mais non confirmée par le prestataire. Le statut sera ' +
          'mis à jour automatiquement — ne relancez pas.',
      };
    }

    await this.events.record({
      kind: PaymentEventKind.PAYOUT,
      provider: provider.name,
      externalId: providerPayoutId,
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
      // Refus définitif à l'envoi : l'argent n'est pas parti. La ligne est
      // close en échec (historique) ; une nouvelle demande devient possible.
      await this.prisma.reservationNoShowPayout.updateMany({
        where: { id: row.id, status: 'PENDING' },
        data: {
          status: 'FAILED',
          failureCode: result.failureCode ?? 'REJECTED',
          failureMessage: result.failureMessage ?? null,
        },
      });
      return {
        payoutId: row.id,
        status: 'FAILED' as const,
        message:
          result.failureMessage ??
          'Le prestataire a refusé le virement. Corrigez le compte puis refaites une demande.',
      };
    }

    return {
      payoutId: row.id,
      status: 'PENDING' as const,
      message:
        'Virement envoyé. Il passera à SUCCESS à la confirmation du prestataire.',
    };
  }

  /** Absences et état de leur versement, les plus récentes d'abord (B-3). */
  async list(params: { state?: NoShowPayoutState; limit?: number }) {
    const active = { status: { in: ACTIVE_NO_SHOW_PAYOUT_STATUSES } };
    const where: Prisma.ReservationNoShowSettlementWhereInput =
      params.state === 'NOTHING_DUE'
        ? { vendorShareXaf: { lte: 0 } }
        : params.state === 'DUE'
          ? { vendorShareXaf: { gt: 0 }, payouts: { none: active } }
          : params.state === 'IN_PROGRESS'
            ? { payouts: { some: { status: 'PENDING' } } }
            : params.state === 'PAID'
              ? { payouts: { some: { status: 'SUCCESS' } } }
              : {};
    const settlements = await this.prisma.reservationNoShowSettlement.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(params.limit ?? 50, 1), 100),
      select: {
        id: true,
        reservationId: true,
        orderId: true,
        totalXaf: true,
        vendorShareXaf: true,
        platformShareXaf: true,
        vendorShareBps: true,
        createdAt: true,
        restaurant: { select: { id: true, nom: true } },
        payouts: {
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            status: true,
            amountXaf: true,
            phoneNumber: true,
            payoutProvider: true,
            failureCode: true,
            failureMessage: true,
            requestedBy: true,
            approvedBy: true,
            createdAt: true,
            completedAt: true,
          },
        },
      },
    });
    return settlements.map(({ id, payouts, ...s }) => ({
      settlementId: id,
      ...s,
      payoutState: noShowPayoutState(
        s.vendorShareXaf,
        payouts.map((p) => p.status),
      ),
      // Le numéro complet n'est jamais renvoyé par une liste.
      payouts: payouts.map(({ phoneNumber, ...p }) => ({
        ...p,
        maskedPhone: maskPhone(phoneNumber),
      })),
    }));
  }

  // ─── Outils ──────────────────────────────────────────────────────────────

  private async assertNoActivePayout(
    db: Prisma.TransactionClient,
    settlementId: string,
  ): Promise<void> {
    const active = await db.reservationNoShowPayout.findFirst({
      where: {
        settlementId,
        status: { in: ACTIVE_NO_SHOW_PAYOUT_STATUSES },
      },
      select: { status: true },
    });
    if (active) {
      throw new ConflictException({
        message:
          active.status === 'SUCCESS'
            ? 'La part de cette absence a déjà été versée.'
            : 'Un versement est déjà en cours pour cette absence. Attendez son issue.',
        code: 'NO_SHOW_PAYOUT_ALREADY_ACTIVE',
      });
    }
  }

  private async accountChangePending(
    db: Prisma.TransactionClient,
    restaurantId: string,
  ): Promise<boolean> {
    const pending = await db.financialApproval.count({
      where: {
        kind: ApprovalKind.PAYOUT_ACCOUNT_CHANGE,
        refId: restaurantId,
        status: ApprovalStatus.PENDING,
        expiresAt: { gt: new Date() },
      },
    });
    return pending > 0;
  }
}
