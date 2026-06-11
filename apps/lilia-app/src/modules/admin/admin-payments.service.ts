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
   *   - `validationDelay` : délai moyen PENDING → confirmation (`updatedAt` -
   *     `createdAt`) des paiements confirmés sur 7j roulants — instrument de
   *     mesure de la DoD LIL-78 (« délai moyen de validation < 10 min »).
   */
  async getPaymentsStats() {
    const now = new Date();
    const startOfMonth = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
    );
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    const [pending, monthSuccess, last7DaysSuccess, recentConfirmed] =
      await Promise.all([
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
        // `updatedAt` d'un paiement SUCCESS = instant de confirmation (le passage
        // à SUCCESS est sa dernière écriture, cf. confirmManualPayment /
        // checkPaymentStatus). On calcule la moyenne en JS — volume faible au
        // lancement, et ça reste lisible/testable vs un AVG(EXTRACT(EPOCH...)) raw.
        this.prisma.payment.findMany({
          where: {
            status: PaymentStatus.SUCCESS,
            createdAt: { gte: sevenDaysAgo },
          },
          select: { createdAt: true, updatedAt: true },
        }),
      ]);

    const validationDelay = this.computeValidationDelay(recentConfirmed);

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
      validationDelay,
    };
  }

  /**
   * Délai moyen de validation sur l'échantillon fourni (paiements confirmés).
   * `avgMinutes = null` si l'échantillon est vide (pas de données → pas de
   * fausse valeur de 0 min). Arrondi à 1 décimale.
   */
  private computeValidationDelay(
    payments: { createdAt: Date; updatedAt: Date }[],
  ): { avgMinutes: number | null; sampleCount: number } {
    if (payments.length === 0) {
      return { avgMinutes: null, sampleCount: 0 };
    }
    const totalMs = payments.reduce(
      (sum, p) => sum + (p.updatedAt.getTime() - p.createdAt.getTime()),
      0,
    );
    const avgMinutes = totalMs / payments.length / 60_000;
    return {
      avgMinutes: Math.round(avgMinutes * 10) / 10,
      sampleCount: payments.length,
    };
  }
}
