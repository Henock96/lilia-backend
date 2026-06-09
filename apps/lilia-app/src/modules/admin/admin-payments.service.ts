import { BadRequestException, Injectable } from '@nestjs/common';
import { PaymentStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Supervision paiements côté admin (LIL-134) : liste paginée filtrable + KPI
 * agrégés (à confirmer / encaissé ce mois / 7 derniers jours). Extrait de
 * `AdminService` (lectures Prisma uniquement). `AdminService` y délègue.
 */
@Injectable()
export class AdminPaymentsService {
  constructor(private prisma: PrismaService) {}

  async listPayments(page = 1, limit = 20, status?: string) {
    const normalized = status?.trim() ? status.trim() : undefined;
    if (normalized !== undefined) {
      const validStatuses = Object.values(PaymentStatus) as string[];
      if (!validStatuses.includes(normalized)) {
        throw new BadRequestException(
          `Statut de paiement invalide : ${normalized}. Valeurs acceptées : ${validStatuses.join(', ')}`,
        );
      }
    }
    const where = normalized
      ? { status: normalized as PaymentStatus }
      : {};

    const [payments, total] = await Promise.all([
      this.prisma.payment.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        include: {
          order: {
            select: {
              id: true,
              total: true,
              status: true,
              paymentMethod: true,
              user: { select: { id: true, nom: true, phone: true } },
              // LIL-132 : nom + type du vendeur pour distinguer rapidement
              // les paiements dans la queue admin (boulangerie X vs resto Y).
              restaurant: {
                select: { id: true, nom: true, vendorType: true },
              },
            },
          },
        },
      }),
      this.prisma.payment.count({ where }),
    ]);

    return { data: payments, total, page, limit };
  }

  /**
   * KPI agrégés pour la carte stats `/admin/paiements` :
   *   - `pending` : nombre + montant total des paiements à confirmer
   *   - `monthSuccess` : SUCCESS depuis le 1er du mois (à fuseau UTC pour
   *     simplifier — Brazzaville = UTC+1, écart négligeable sur les bornes)
   *   - `last7DaysSuccess` : SUCCESS sur les 7 derniers jours roulants
   */
  async getPaymentsStats() {
    const now = new Date();
    const startOfMonth = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
    );
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    const [pending, monthSuccess, last7DaysSuccess] = await Promise.all([
      this.prisma.payment.aggregate({
        where: { status: PaymentStatus.PENDING },
        _count: { _all: true },
        _sum: { amount: true },
      }),
      this.prisma.payment.aggregate({
        where: {
          status: PaymentStatus.SUCCESS,
          createdAt: { gte: startOfMonth },
        },
        _count: { _all: true },
        _sum: { amount: true },
      }),
      this.prisma.payment.aggregate({
        where: {
          status: PaymentStatus.SUCCESS,
          createdAt: { gte: sevenDaysAgo },
        },
        _count: { _all: true },
        _sum: { amount: true },
      }),
    ]);

    return {
      pending: {
        count: pending._count._all,
        totalXaf: pending._sum.amount ?? 0,
      },
      monthSuccess: {
        count: monthSuccess._count._all,
        totalXaf: monthSuccess._sum.amount ?? 0,
      },
      last7DaysSuccess: {
        count: last7DaysSuccess._count._all,
        totalXaf: last7DaysSuccess._sum.amount ?? 0,
      },
    };
  }
}
