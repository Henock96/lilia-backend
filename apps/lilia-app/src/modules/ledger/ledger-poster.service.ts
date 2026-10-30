import { Injectable, Logger } from '@nestjs/common';
import { PaymentEventSource } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { LedgerOrigin, LedgerPostingMode } from './ledger-accounts';
import {
  LedgerPostingError,
  Posting,
  acquisitionPosting,
  collectionPosting,
  driverCostPosting,
  driverSettlementPosting,
  payoutPosting,
  pspFeePosting,
  refundPosting,
  vendorAdjustmentPosting,
} from './ledger-postings';
import { LedgerService } from './ledger.service';

export interface PassReport {
  posted: number;
  duplicates: number;
  exceptions: number;
  /** Faits rattachés à une commande exclue (commande de test). */
  excluded: number;
}

export interface CatchUpReport {
  collections: PassReport;
  acquisitions: PassReport;
  driverCosts: PassReport;
  refunds: PassReport;
  payouts: PassReport;
  fees: PassReport;
  driverSettlements: PassReport;
  vendorAdjustments: PassReport;
}

const empty = (): PassReport => ({
  posted: 0,
  duplicates: 0,
  exceptions: 0,
  excluded: 0,
});

/** Source d'un `PaymentEvent` → origine de la preuve dans le grand livre. */
export function originFromEvent(
  source: PaymentEventSource | null | undefined,
  provider: string,
): LedgerOrigin {
  switch (source) {
    case 'WEBHOOK':
      // Historique antérieur au 30/10 : la confirmation manuelle était
      // enregistrée `WEBHOOK` avec le prestataire `MANUAL` (F-10).
      return provider === 'MANUAL' ? 'ADMIN' : 'WEBHOOK';
    case 'RECONCILIATION':
      return 'RECONCILIATION';
    case 'CLIENT_POLL':
      return 'CLIENT_POLL';
    case 'INITIATION':
      return 'INITIATION';
    case 'ADMIN':
      return 'ADMIN';
    default:
      return 'UNKNOWN';
  }
}

/**
 * Posteur du grand livre (lot 2, 30/10/2026).
 *
 * ## Pourquoi un posteur plutôt qu'une écriture dans chaque chemin d'argent
 *
 * Les mouvements d'argent existent déjà, durables et testés, dans six tables
 * (`payments`, `Order`, `Refund`, `restaurant_payouts`, `driver_settlements`,
 * `VendorBalanceEntry`). Insérer une écriture comptable dans chacun de leurs
 * chemins (webhook, sondage, cron, approbation, clôture manuelle…) aurait
 * touché une dizaine de transactions financières déjà prouvées.
 *
 * Le posteur dérive le grand livre de ces faits. C'est le « mécanisme durable »
 * admis par la mission, et sa garantie se démontre (`ledger.int-spec.ts`) :
 *  · le fait source est déjà engagé en base avant d'être lu : rien ne peut
 *    être écrit pour un fait qui n'existe pas ;
 *  · chaque fait s'écrit en UNE transaction PostgreSQL, équilibrée par trigger ;
 *  · `sourceEventKey` unique : rejouer le posteur, ou en lancer deux à la
 *    fois, ne compte jamais un fait deux fois ;
 *  · un fait qui ne peut s'écrire sans inventer part en exception, jamais en
 *    écriture forcée.
 * Le délai entre le fait et son écriture est celui du cron (5 min).
 *
 * ## Ordre des passes
 *
 * Encaissements, puis acquisitions, avant remboursements : un remboursement
 * se répartit différemment selon que la commande a été acquise ou non.
 *
 * ## Reprise historique
 *
 * C'est le même posteur, en mode `BACKFILL` pour les faits antérieurs à
 * `backfillBefore`. Les commandes de test sont exclues par la liste explicite
 * `LedgerExcludedOrder` (jamais par heuristique).
 *
 * ## Échelle
 *
 * Chaque passe relit les faits du type et écarte ceux déjà écrits (une requête
 * par lot de clés). Suffisant au volume actuel ; à remplacer par un curseur
 * (`id > dernier écrit`) au-delà de quelques dizaines de milliers de faits.
 */
@Injectable()
export class LedgerPosterService {
  private readonly logger = new Logger(LedgerPosterService.name);
  private static readonly BATCH = 500;

  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
  ) {}

  async catchUp(
    options: { backfillBefore?: Date } = {},
  ): Promise<CatchUpReport> {
    const report: CatchUpReport = {
      collections: empty(),
      acquisitions: empty(),
      driverCosts: empty(),
      refunds: empty(),
      payouts: empty(),
      fees: empty(),
      driverSettlements: empty(),
      vendorAdjustments: empty(),
    };
    const mode = (at: Date): LedgerPostingMode =>
      options.backfillBefore && at < options.backfillBefore
        ? 'BACKFILL'
        : 'LIVE';

    const excluded = new Set(
      (
        await this.prisma.ledgerExcludedOrder.findMany({
          select: { orderId: true },
        })
      ).map((x) => x.orderId),
    );

    await this.passCollections(report.collections, mode, excluded);
    await this.passAcquisitions(report.acquisitions, mode, excluded);
    await this.passDriverCosts(report.driverCosts, mode, excluded);
    await this.passRefunds(report.refunds, mode, excluded);
    await this.passPayouts(report.payouts, mode, excluded);
    await this.passFees(report.fees, mode, excluded);
    await this.passDriverSettlements(report.driverSettlements, mode);
    await this.passVendorAdjustments(report.vendorAdjustments, mode);

    const all = Object.values(report);
    const posted = all.reduce((s, r) => s + r.posted, 0);
    const exceptions = all.reduce((s, r) => s + r.exceptions, 0);
    if (posted || exceptions) {
      this.logger.log(
        `Grand livre : ${posted} transaction(s) écrite(s), ${exceptions} exception(s)`,
      );
    }
    return report;
  }

  /** Clés déjà écrites parmi celles proposées (une requête par lot). */
  private async alreadyPosted(keys: string[]): Promise<Set<string>> {
    if (keys.length === 0) return new Set();
    const rows = await this.prisma.ledgerTransaction.findMany({
      where: { sourceEventKey: { in: keys } },
      select: { sourceEventKey: true },
    });
    return new Set(rows.map((r) => r.sourceEventKey));
  }

  /** Écrit un fait ; une impossibilité devient une exception consignée. */
  private async apply(
    stats: PassReport,
    source: { sourceType: string; sourceId: string },
    build: () => Posting,
    mode: (at: Date) => LedgerPostingMode,
  ): Promise<void> {
    let posting: Posting;
    try {
      posting = build();
    } catch (err) {
      if (err instanceof LedgerPostingError) {
        await this.ledger.recordException(err, source);
        stats.exceptions++;
        return;
      }
      throw err;
    }
    const outcome = await this.ledger.post(posting, mode(posting.occurredAt));
    if (outcome === 'POSTED') stats.posted++;
    else stats.duplicates++;
  }

  private async passCollections(
    stats: PassReport,
    mode: (at: Date) => LedgerPostingMode,
    excluded: Set<string>,
  ) {
    const payments = await this.prisma.payment.findMany({
      where: { status: 'SUCCESS' },
      select: {
        id: true,
        orderId: true,
        provider: true,
        amount: true,
        completedAt: true,
        updatedAt: true,
        providerTransactionId: true,
      },
      orderBy: { id: 'asc' },
    });
    const done = await this.alreadyPosted(
      payments.map((p) => `payment:${p.id}:success`),
    );
    const todo = payments
      .filter((p) => !done.has(`payment:${p.id}:success`))
      .slice(0, LedgerPosterService.BATCH);
    for (const p of todo) {
      if (excluded.has(p.orderId)) {
        stats.excluded++;
        continue;
      }
      // La preuve : la première conclusion appliquée de ce paiement.
      const applied = await this.prisma.paymentEvent.findFirst({
        where: { paymentId: p.id, kind: 'COLLECTION', outcome: 'APPLIED' },
        orderBy: { receivedAt: 'asc' },
        select: { source: true },
      });
      await this.apply(
        stats,
        { sourceType: 'Payment', sourceId: p.id },
        () =>
          collectionPosting({
            payment: {
              id: p.id,
              orderId: p.orderId,
              provider: p.provider,
              amount: p.amount,
              completedAt: p.completedAt ?? p.updatedAt,
              providerTransactionId: p.providerTransactionId,
            },
            origin: originFromEvent(applied?.source, p.provider),
          }),
        mode,
      );
    }
  }

  private async passAcquisitions(
    stats: PassReport,
    mode: (at: Date) => LedgerPostingMode,
    excluded: Set<string>,
  ) {
    const orders = await this.prisma.order.findMany({
      where: { status: 'LIVRER' },
      select: {
        id: true,
        restaurantId: true,
        subTotal: true,
        deliveryFee: true,
        serviceFee: true,
        total: true,
        discountAmount: true,
        vendorFundedDiscountXaf: true,
        vendorDeliverySubsidyXaf: true,
        commissionPercent: true,
        deliveredAt: true,
        updatedAt: true,
      },
      orderBy: { id: 'asc' },
    });
    const done = await this.alreadyPosted(
      orders.map((o) => `order:${o.id}:acquired`),
    );
    const todo = orders
      .filter((o) => !done.has(`order:${o.id}:acquired`))
      .slice(0, LedgerPosterService.BATCH);
    for (const o of todo) {
      if (excluded.has(o.id)) {
        stats.excluded++;
        continue;
      }
      const { updatedAt, ...rest } = o;
      await this.apply(
        stats,
        { sourceType: 'Order', sourceId: o.id },
        () =>
          acquisitionPosting({
            ...rest,
            deliveredAt: o.deliveredAt ?? updatedAt,
          }),
        mode,
      );
    }
  }

  private async passDriverCosts(
    stats: PassReport,
    mode: (at: Date) => LedgerPostingMode,
    excluded: Set<string>,
  ) {
    const deliveries = await this.prisma.delivery.findMany({
      where: {
        order: { status: 'LIVRER' },
        delivererId: { not: null },
        driverPayXaf: { gt: 0 },
      },
      select: {
        id: true,
        orderId: true,
        delivererId: true,
        driverPayXaf: true,
        deliveredAt: true,
        updatedAt: true,
      },
      orderBy: { id: 'asc' },
    });
    const done = await this.alreadyPosted(
      deliveries.map((d) => `delivery:${d.id}:driver_cost`),
    );
    const todo = deliveries
      .filter((d) => !done.has(`delivery:${d.id}:driver_cost`))
      .slice(0, LedgerPosterService.BATCH);
    for (const d of todo) {
      if (excluded.has(d.orderId)) {
        stats.excluded++;
        continue;
      }
      await this.apply(
        stats,
        { sourceType: 'Delivery', sourceId: d.id },
        () =>
          driverCostPosting({
            id: d.id,
            delivererId: d.delivererId!,
            driverPayXaf: d.driverPayXaf!,
            deliveredAt: d.deliveredAt ?? d.updatedAt,
          }),
        mode,
      );
    }
  }

  private async passRefunds(
    stats: PassReport,
    mode: (at: Date) => LedgerPostingMode,
    excluded: Set<string>,
  ) {
    const refunds = await this.prisma.refund.findMany({
      where: { status: 'COMPLETED' },
      select: {
        id: true,
        orderId: true,
        amount: true,
        bearer: true,
        closureMethod: true,
        provider: true,
        processedAt: true,
        updatedAt: true,
        providerTransactionId: true,
        externalReference: true,
        externalPaidAt: true,
        order: {
          select: {
            restaurantId: true,
            delivery: { select: { delivererId: true } },
          },
        },
      },
      orderBy: { id: 'asc' },
    });
    const done = await this.alreadyPosted(
      refunds.map((r) => `refund:${r.id}:completed`),
    );
    const todo = refunds
      .filter((r) => !done.has(`refund:${r.id}:completed`))
      .slice(0, LedgerPosterService.BATCH);
    const acquired = await this.alreadyPosted(
      todo.map((r) => `order:${r.orderId}:acquired`),
    );
    for (const r of todo) {
      if (excluded.has(r.orderId)) {
        stats.excluded++;
        continue;
      }
      await this.apply(
        stats,
        { sourceType: 'Refund', sourceId: r.id },
        () =>
          refundPosting({
            refund: {
              id: r.id,
              orderId: r.orderId,
              amount: r.amount,
              bearer: r.bearer,
              closureMethod: r.closureMethod,
              provider: r.provider,
              processedAt: r.externalPaidAt ?? r.processedAt ?? r.updatedAt,
              providerTransactionId: r.providerTransactionId,
              externalReference: r.externalReference,
            },
            acquired: acquired.has(`order:${r.orderId}:acquired`),
            restaurantId: r.order.restaurantId,
            delivererId: r.order.delivery?.delivererId ?? null,
          }),
        mode,
      );
    }
  }

  private async passPayouts(
    stats: PassReport,
    mode: (at: Date) => LedgerPostingMode,
    excluded: Set<string>,
  ) {
    const payouts = await this.prisma.restaurantPayout.findMany({
      where: { status: 'SUCCESS' },
      select: {
        id: true,
        orderId: true,
        restaurantId: true,
        amount: true,
        provider: true,
        status: true,
        completedAt: true,
        updatedAt: true,
        providerTransactionId: true,
        providerPayoutId: true,
      },
      orderBy: { id: 'asc' },
    });
    const done = await this.alreadyPosted(
      payouts.map((p) => `payout:${p.id}:success`),
    );
    const todo = payouts
      .filter((p) => !done.has(`payout:${p.id}:success`))
      .slice(0, LedgerPosterService.BATCH);
    for (const p of todo) {
      if (excluded.has(p.orderId)) {
        stats.excluded++;
        continue;
      }
      const applied = await this.prisma.paymentEvent.findFirst({
        where: { payoutId: p.id, outcome: 'APPLIED' },
        orderBy: { receivedAt: 'asc' },
        select: { source: true },
      });
      await this.apply(
        stats,
        { sourceType: 'RestaurantPayout', sourceId: p.id },
        () =>
          payoutPosting({
            payout: { ...p, completedAt: p.completedAt ?? p.updatedAt },
            origin: originFromEvent(applied?.source, p.provider),
          }),
        mode,
      );
    }
  }

  /** Frais CONFIRMÉS seulement : `null` = inconnu, jamais estimé ici. */
  private async passFees(
    stats: PassReport,
    mode: (at: Date) => LedgerPostingMode,
    excluded: Set<string>,
  ) {
    const paymentFees = await this.prisma.payment.findMany({
      where: { status: 'SUCCESS', collectionFeeXaf: { gt: 0 } },
      select: {
        id: true,
        orderId: true,
        provider: true,
        collectionFeeXaf: true,
        completedAt: true,
        updatedAt: true,
      },
    });
    const payoutFees = await this.prisma.restaurantPayout.findMany({
      where: { status: 'SUCCESS', payoutFeeXaf: { gt: 0 } },
      select: {
        id: true,
        orderId: true,
        provider: true,
        payoutFeeXaf: true,
        completedAt: true,
        updatedAt: true,
      },
    });
    const done = await this.alreadyPosted([
      ...paymentFees.map((p) => `payment:${p.id}:fee`),
      ...payoutFees.map((p) => `payout:${p.id}:fee`),
    ]);
    for (const p of paymentFees) {
      if (done.has(`payment:${p.id}:fee`)) continue;
      if (excluded.has(p.orderId)) {
        stats.excluded++;
        continue;
      }
      await this.apply(
        stats,
        { sourceType: 'Payment', sourceId: p.id },
        () =>
          pspFeePosting({
            source: 'Payment',
            id: p.id,
            provider: p.provider,
            feeXaf: p.collectionFeeXaf!,
            at: p.completedAt ?? p.updatedAt,
          }),
        mode,
      );
    }
    for (const p of payoutFees) {
      if (done.has(`payout:${p.id}:fee`)) continue;
      if (excluded.has(p.orderId)) {
        stats.excluded++;
        continue;
      }
      await this.apply(
        stats,
        { sourceType: 'RestaurantPayout', sourceId: p.id },
        () =>
          pspFeePosting({
            source: 'RestaurantPayout',
            id: p.id,
            provider: p.provider,
            feeXaf: p.payoutFeeXaf!,
            at: p.completedAt ?? p.updatedAt,
          }),
        mode,
      );
    }
  }

  private async passDriverSettlements(
    stats: PassReport,
    mode: (at: Date) => LedgerPostingMode,
  ) {
    const settlements = await this.prisma.driverSettlement.findMany({
      where: { status: 'PAID' },
      select: {
        id: true,
        driverId: true,
        amountXaf: true,
        paidAt: true,
        reference: true,
        method: true,
      },
    });
    const done = await this.alreadyPosted(
      settlements.map((s) => `driver_settlement:${s.id}:paid`),
    );
    for (const s of settlements.filter(
      (s) => !done.has(`driver_settlement:${s.id}:paid`),
    )) {
      await this.apply(
        stats,
        { sourceType: 'DriverSettlement', sourceId: s.id },
        () => driverSettlementPosting(s),
        mode,
      );
    }
  }

  private async passVendorAdjustments(
    stats: PassReport,
    mode: (at: Date) => LedgerPostingMode,
  ) {
    const entries = await this.prisma.vendorBalanceEntry.findMany({
      where: { kind: 'ADJUSTMENT' },
      select: {
        id: true,
        restaurantId: true,
        amountXaf: true,
        createdAt: true,
        note: true,
      },
    });
    const done = await this.alreadyPosted(
      entries.map((e) => `vendor_balance:${e.id}:adjustment`),
    );
    for (const e of entries.filter(
      (e) => !done.has(`vendor_balance:${e.id}:adjustment`),
    )) {
      await this.apply(
        stats,
        { sourceType: 'VendorBalanceEntry', sourceId: e.id },
        () => vendorAdjustmentPosting(e),
        mode,
      );
    }
  }
}
