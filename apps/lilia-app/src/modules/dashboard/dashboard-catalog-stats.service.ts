/* eslint-disable prettier/prettier */
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { DashboardCommonService } from './dashboard-common.service';

/**
 * Statistiques catalogue & marketplace (extrait de DashboardService — LIL-142).
 * Produits les plus vendus et stats vendeurs (admin).
 */
@Injectable()
export class DashboardCatalogStatsService {
  constructor(
    private prisma: PrismaService,
    private readonly common: DashboardCommonService,
  ) {}

  /**
   * Récupère les produits les plus vendus
   */
  async getTopProducts(firebaseUid: string, limit = 10, period?: string) {
    const restaurant = await this.common.getRestaurant(firebaseUid);
    const restaurantFilter = restaurant ? { restaurantId: restaurant.id } : {};

    const dateFilter = this.common.getDateFilter(period);

    const topProducts = await this.prisma.orderItem.groupBy({
      by: ['productId'],
      where: {
        order: {
          ...restaurantFilter,
          status: { not: 'ANNULER' },
          ...(dateFilter && { createdAt: { gte: dateFilter } }),
        },
      },
      _sum: { quantite: true, prix: true },
      _count: { productId: true },
      orderBy: { _sum: { quantite: 'desc' } },
      take: limit,
    });

    // Récupérer les détails des produits
    const productIds = topProducts.map((p) => p.productId);
    const products = await this.prisma.product.findMany({
      where: { id: { in: productIds } },
      select: {
        id: true,
        nom: true,
        imageUrl: true,
        prixOriginal: true,
      },
    });

    const productsMap = new Map(products.map((p) => [p.id, p]));

    return {
      data: topProducts.map((tp, index) => ({
        rank: index + 1,
        product: productsMap.get(tp.productId),
        totalSold: tp._sum.quantite || 0,
        totalRevenue: tp._sum.prix || 0,
        orderCount: tp._count.productId,
      })),
    };
  }

  /**
   * Statistiques vendeurs pour le dashboard admin (LIL-113).
   * Retourne le total, les vendeurs en attente de validation,
   * et la répartition par VendorType et par statut.
   */
  async getVendorStats() {
    const [total, pendingApproval, suspended, byType] = await Promise.all([
      this.prisma.restaurant.count(),
      this.prisma.restaurant.count({ where: { adminApproved: false } }),
      this.prisma.restaurant.count({
        where: { adminApproved: true, isActive: false },
      }),
      this.prisma.restaurant.groupBy({
        by: ['vendorType'],
        _count: { vendorType: true },
      }),
    ]);

    return {
      total,
      pendingApproval,
      suspended,
      byType: Object.fromEntries(
        byType.map((row) => [row.vendorType, row._count.vendorType]),
      ),
    };
  }
}
