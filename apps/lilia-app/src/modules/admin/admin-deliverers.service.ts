import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, DeliveryStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { DelivererMissionStatus } from './dto/get-deliverer-missions.dto';

/**
 * Supervision livreurs côté admin (LIL-134) : liste, stats agrégées, historique
 * de missions. Extrait de `AdminService` (lectures Prisma uniquement).
 * `AdminService` y délègue — API publique inchangée.
 */
@Injectable()
export class AdminDeliverersService {
  constructor(private prisma: PrismaService) {}

  async getAllDeliverers(page = 1, limit = 20) {
    const [deliverers, total] = await Promise.all([
      this.prisma.user.findMany({
        where: { role: 'LIVREUR' },
        select: {
          id: true,
          email: true,
          nom: true,
          phone: true,
          imageUrl: true,
          createdAt: true,
          deliveries: {
            select: { id: true, status: true, createdAt: true },
            orderBy: { createdAt: 'desc' },
            take: 5, // 5 dernières livraisons
          },
          _count: { select: { deliveries: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.user.count({ where: { role: 'LIVREUR' } }),
    ]);

    return { data: deliverers, total, page, limit };
  }

  async getDelivererStats(delivererId: string) {
    const deliverer = await this.prisma.user.findUnique({
      where: { id: delivererId },
      select: { id: true, role: true },
    });
    if (!deliverer || deliverer.role !== 'LIVREUR') {
      throw new NotFoundException('Livreur introuvable');
    }

    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const [grouped, deliveredRows, last30dDeliveries, lastDelivery] =
      await Promise.all([
        this.prisma.delivery.groupBy({
          by: ['status'],
          where: { delivererId },
          _count: { _all: true },
        }),
        // Toutes les deliveries LIVRER pour calculer revenue et avg duration
        this.prisma.delivery.findMany({
          where: { delivererId, status: DeliveryStatus.LIVRER },
          select: {
            pickedUpAt: true,
            deliveredAt: true,
            order: { select: { total: true } },
          },
        }),
        this.prisma.delivery.count({
          where: { delivererId, createdAt: { gte: thirtyDaysAgo } },
        }),
        this.prisma.delivery.findFirst({
          where: {
            delivererId,
            status: DeliveryStatus.LIVRER,
            deliveredAt: { not: null },
          },
          orderBy: { deliveredAt: 'desc' },
          select: { deliveredAt: true },
        }),
      ]);

    const countOf = (status: DeliveryStatus) =>
      grouped.find((g) => g.status === status)?._count?._all ?? 0;

    const deliveredCount = countOf(DeliveryStatus.LIVRER);
    const failedCount = countOf(DeliveryStatus.ECHEC);
    const inProgressCount =
      countOf(DeliveryStatus.ASSIGNER) + countOf(DeliveryStatus.EN_TRANSIT);
    const totalDeliveries = grouped.reduce(
      (sum, g) => sum + (g._count?._all ?? 0),
      0,
    );

    const finished = deliveredCount + failedCount;
    const successRate =
      finished === 0
        ? 0
        : Math.round((deliveredCount / finished) * 100 * 100) / 100;

    const totalRevenueXAF = deliveredRows.reduce(
      (sum, d) => sum + (d.order?.total ?? 0),
      0,
    );

    const durations = deliveredRows
      .filter((d) => d.pickedUpAt && d.deliveredAt)
      .map(
        (d) =>
          (d.deliveredAt!.getTime() - d.pickedUpAt!.getTime()) / 60000,
      );
    const avgDeliveryMinutes =
      durations.length === 0
        ? null
        : Math.round(
            (durations.reduce((s, x) => s + x, 0) / durations.length) * 100,
          ) / 100;

    return {
      data: {
        totalDeliveries,
        deliveredCount,
        failedCount,
        inProgressCount,
        successRate,
        totalRevenueXAF,
        avgDeliveryMinutes,
        last30dDeliveries,
        lastDeliveryAt: lastDelivery?.deliveredAt ?? null,
      },
    };
  }

  async getDelivererMissions(
    delivererId: string,
    status?: DelivererMissionStatus,
    page = 1,
    limit = 20,
  ) {
    const deliverer = await this.prisma.user.findUnique({
      where: { id: delivererId },
      select: { id: true, role: true },
    });
    if (!deliverer || deliverer.role !== 'LIVREUR') {
      throw new NotFoundException('Livreur introuvable');
    }

    const where: Prisma.DeliveryWhereInput = {
      delivererId,
      ...(status ? { status } : {}),
    };

    const [deliveries, total] = await Promise.all([
      this.prisma.delivery.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          orderId: true,
          status: true,
          createdAt: true,
          pickedUpAt: true,
          deliveredAt: true,
          order: {
            select: {
              total: true,
              restaurant: { select: { nom: true } },
              user: { select: { nom: true } },
            },
          },
        },
      }),
      this.prisma.delivery.count({ where }),
    ]);

    const data = deliveries.map((d) => ({
      id: d.id,
      orderId: d.orderId,
      status: d.status,
      restaurantName: d.order?.restaurant?.nom ?? null,
      clientName: d.order?.user?.nom ?? null,
      totalXAF: d.order?.total ?? 0,
      acceptedAt: d.pickedUpAt ?? null,
      deliveredAt: d.deliveredAt ?? null,
      createdAt: d.createdAt,
    }));

    const totalPages = limit > 0 ? Math.ceil(total / limit) : 0;

    return {
      data,
      meta: { total, page, limit, totalPages },
    };
  }
}
