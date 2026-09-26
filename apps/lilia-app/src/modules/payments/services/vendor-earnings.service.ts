import { Injectable } from '@nestjs/common';
import { OrderStatus, PayoutStatus, Prisma } from '@prisma/client';

import { PrismaService } from '../../../prisma/prisma.service';
import { computePayoutBreakdown, toXaf } from '../money.util';

/**
 * « Mes gains » du vendeur (F3-07) — lecture seule.
 *
 * Un versement par commande, envoyé seul (D6) : c'est l'argument de confiance
 * de la décision, à condition que le vendeur VOIE ce qui arrive. Quatre
 * questions, dans l'ordre où il se les pose :
 *
 *  1. qu'est-ce qui va m'être versé, et quand ? (`upcoming`)
 *  2. qu'est-ce qui attend une preuve de remise ? (`awaitingProof`)
 *  3. qu'ai-je reçu ? (`payouts`, avec le détail de chaque retenue)
 *  4. est-ce que je dois quelque chose ? (`debtXaf`, `debtEntries`)
 *
 * Les montants « à venir » sont des ESTIMATIONS : la retenue d'un
 * remboursement ou d'une dette n'est connue qu'au versement, sous verrou.
 */
@Injectable()
export class VendorEarningsService {
  constructor(private readonly prisma: PrismaService) {}

  async forOwner(ownerId: string, page = 1, limit = 20) {
    const restaurants = await this.prisma.restaurant.findMany({
      where: { ownerId },
      select: { id: true },
    });
    const ids = restaurants.map((r) => r.id);
    const since30d = new Date(Date.now() - 30 * 24 * 3_600_000);

    const orderBase: Prisma.OrderWhereInput = {
      restaurantId: { in: ids },
      status: OrderStatus.LIVRER,
      payout: { is: null },
    };

    const [
      upcomingOrders,
      awaitingProof,
      payouts,
      total,
      pending,
      paid30d,
      balance,
      debtEntries,
    ] = await Promise.all([
      this.prisma.order.findMany({
        where: { ...orderBase, payoutDueAt: { not: null } },
        orderBy: { payoutDueAt: 'asc' },
        take: 20,
        select: {
          id: true,
          subTotal: true,
          commissionPercent: true,
          vendorDeliverySubsidyXaf: true,
          // F3-11 — offre boutique consentie, retenue au versement.
          vendorFundedDiscountXaf: true,
          payoutDueAt: true,
          deliveryProof: true,
        },
      }),
      // `payoutDueAt IS NULL` suffit : le CHECK I-6/I-7 garantit qu'il équivaut
      // à « pas de preuve fiable » (remise déclarée seule, course sans code,
      // ou commande antérieure). Un filtre `deliveryProof NOT IN (…)` écartait
      // ces dernières : en SQL, `NULL NOT IN (…)` n'est jamais vrai.
      this.prisma.order.count({
        where: { ...orderBase, payoutDueAt: null },
      }),
      this.prisma.restaurantPayout.findMany({
        where: { restaurantId: { in: ids } },
        orderBy: { requestedAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          orderId: true,
          status: true,
          provider: true,
          grossAmount: true,
          commissionAmount: true,
          deliverySubsidyAmount: true,
          vendorOfferAmount: true,
          refundDeductionAmount: true,
          debtDeductionAmount: true,
          amount: true,
          requestedAt: true,
          completedAt: true,
        },
      }),
      this.prisma.restaurantPayout.count({
        where: { restaurantId: { in: ids } },
      }),
      this.prisma.restaurantPayout.aggregate({
        where: { restaurantId: { in: ids }, status: PayoutStatus.PENDING },
        _sum: { amount: true },
      }),
      this.prisma.restaurantPayout.aggregate({
        where: {
          restaurantId: { in: ids },
          status: PayoutStatus.SUCCESS,
          completedAt: { gte: since30d },
        },
        _sum: { amount: true },
      }),
      this.prisma.vendorBalanceEntry.aggregate({
        where: { restaurantId: { in: ids } },
        _sum: { amountXaf: true },
      }),
      this.prisma.vendorBalanceEntry.findMany({
        where: { restaurantId: { in: ids } },
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: {
          id: true,
          kind: true,
          amountXaf: true,
          orderId: true,
          note: true,
          createdAt: true,
        },
      }),
    ]);

    const upcoming = upcomingOrders.map((o) => ({
      orderId: o.id,
      orderRef: ref(o.id),
      payoutDueAt: o.payoutDueAt,
      deliveryProof: o.deliveryProof,
      estimatedXaf: computePayoutBreakdown({
        subTotalXaf: toXaf(o.subTotal, 'sous-total'),
        commissionPercent: o.commissionPercent,
        deliverySubsidyXaf: o.vendorDeliverySubsidyXaf ?? 0,
        vendorOfferDiscountXaf: o.vendorFundedDiscountXaf ?? 0,
      }).payoutAmount,
    }));

    return {
      data: {
        summary: {
          upcomingXaf: upcoming.reduce((s, u) => s + u.estimatedXaf, 0),
          upcomingCount: upcoming.length,
          awaitingProofCount: awaitingProof,
          pendingXaf: pending._sum.amount ?? 0,
          paidLast30DaysXaf: paid30d._sum.amount ?? 0,
          debtXaf: Math.max(0, -(balance._sum.amountXaf ?? 0)),
        },
        upcoming,
        payouts: payouts.map((p) => ({ ...p, orderRef: ref(p.orderId) })),
        debtEntries,
      },
      meta: { page, limit, total },
    };
  }
}

function ref(orderId: string): string {
  return orderId.slice(-6).toUpperCase();
}
