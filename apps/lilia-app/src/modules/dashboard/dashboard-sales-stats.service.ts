/* eslint-disable prettier/prettier */
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { DashboardCommonService } from './dashboard-common.service';

/**
 * Statistiques de ventes (extrait de DashboardService — LIL-142).
 * Vue générale, commandes par statut, évolution du CA, heures de pointe et
 * classement des restaurants.
 */
@Injectable()
export class DashboardSalesStatsService {
  constructor(
    private prisma: PrismaService,
    private readonly common: DashboardCommonService,
  ) {}

  /**
   * Récupère les statistiques générales du dashboard
   */
  async getOverview(firebaseUid: string) {
    const restaurant = await this.common.getRestaurant(firebaseUid);
    const restaurantFilter = restaurant ? { restaurantId: restaurant.id } : {};

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const startOfWeek = new Date(today);
    startOfWeek.setDate(today.getDate() - today.getDay());

    const startOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);

    // Récupérer les statistiques en parallèle
    const [
      totalOrders,
      todayOrders,
      weekOrders,
      monthOrders,
      totalRevenue,
      todayRevenue,
      weekRevenue,
      monthRevenue,
      totalProducts,
      totalClients,
      weekClients,
      monthClients,
      pendingOrders,
      averageRating,
    ] = await Promise.all([
      this.prisma.order.count({
        where: { ...restaurantFilter, status: { not: 'ANNULER' } },
      }),
      this.prisma.order.count({
        where: {
          ...restaurantFilter,
          createdAt: { gte: today },
          status: { not: 'ANNULER' },
        },
      }),
      this.prisma.order.count({
        where: {
          ...restaurantFilter,
          createdAt: { gte: startOfWeek },
          status: { not: 'ANNULER' },
        },
      }),
      this.prisma.order.count({
        where: {
          ...restaurantFilter,
          createdAt: { gte: startOfMonth },
          status: { not: 'ANNULER' },
        },
      }),
      this.prisma.order.aggregate({
        where: { ...restaurantFilter, status: { not: 'ANNULER' } },
        _sum: { total: true },
      }),
      this.prisma.order.aggregate({
        where: {
          ...restaurantFilter,
          createdAt: { gte: today },
          status: { not: 'ANNULER' },
        },
        _sum: { total: true },
      }),
      this.prisma.order.aggregate({
        where: {
          ...restaurantFilter,
          createdAt: { gte: startOfWeek },
          status: { not: 'ANNULER' },
        },
        _sum: { total: true },
      }),
      this.prisma.order.aggregate({
        where: {
          ...restaurantFilter,
          createdAt: { gte: startOfMonth },
          status: { not: 'ANNULER' },
        },
        _sum: { total: true },
      }),
      this.prisma.product.count({
        where: restaurant ? { restaurantId: restaurant.id } : {},
      }),
      this.prisma.order.findMany({
        where: { ...restaurantFilter },
        select: { userId: true },
        distinct: ['userId'],
      }),
      this.prisma.order.findMany({
        where: { ...restaurantFilter, createdAt: { gte: startOfWeek } },
        select: { userId: true },
        distinct: ['userId'],
      }),
      this.prisma.order.findMany({
        where: { ...restaurantFilter, createdAt: { gte: startOfMonth } },
        select: { userId: true },
        distinct: ['userId'],
      }),
      this.prisma.order.count({
        where: {
          ...restaurantFilter,
          status: { in: ['EN_ATTENTE', 'PAYER', 'EN_PREPARATION'] },
        },
      }),
      this.prisma.review.aggregate({
        where: restaurant ? { restaurantId: restaurant.id } : {},
        _avg: { rating: true },
        _count: { rating: true },
      }),
    ]);

    const result: any = {
      data: {
        orders: {
          total: totalOrders,
          today: todayOrders,
          week: weekOrders,
          month: monthOrders,
          pending: pendingOrders,
        },
        revenue: {
          total: totalRevenue._sum.total || 0,
          today: todayRevenue._sum.total || 0,
          week: weekRevenue._sum.total || 0,
          month: monthRevenue._sum.total || 0,
          currency: 'XAF',
        },
        products: {
          total: totalProducts,
        },
        clients: {
          total: totalClients.length,
          week: weekClients.length,
          month: monthClients.length,
        },
        rating: {
          average: averageRating._avg.rating || 0,
          count: averageRating._count.rating,
        },
      },
    };

    // Pour ADMIN : ajouter le nombre total de restaurants
    if (!restaurant) {
      result.data.totalRestaurants = await this.prisma.restaurant.count();
    }

    return result;
  }

  /**
   * Récupère les statistiques des commandes par statut
   */
  async getOrderStats(firebaseUid: string, period?: string) {
    const restaurant = await this.common.getRestaurant(firebaseUid);
    const restaurantFilter = restaurant ? { restaurantId: restaurant.id } : {};

    const dateFilter = this.common.getDateFilter(period);

    const stats = await this.prisma.order.groupBy({
      by: ['status'],
      where: {
        ...restaurantFilter,
        ...(dateFilter && { createdAt: { gte: dateFilter } }),
      },
      _count: { status: true },
      _sum: { total: true },
    });

    const totalOrders = stats.reduce((acc, s) => acc + s._count.status, 0);
    const totalRevenue = stats.reduce((acc, s) => acc + (s._sum.total || 0), 0);

    return {
      data: {
        byStatus: stats.map((s) => ({
          status: s.status,
          count: s._count.status,
          revenue: s._sum.total || 0,
          percentage: totalOrders > 0 ? ((s._count.status / totalOrders) * 100).toFixed(1) : 0,
        })),
        totals: {
          orders: totalOrders,
          revenue: totalRevenue,
          averageOrderValue: totalOrders > 0 ? (totalRevenue / totalOrders).toFixed(0) : 0,
        },
      },
    };
  }

  /**
   * Récupère l'évolution des revenus par jour
   */
  async getRevenueChart(firebaseUid: string, days = 30) {
    const restaurant = await this.common.getRestaurant(firebaseUid);
    const restaurantFilter = restaurant ? { restaurantId: restaurant.id } : {};

    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);
    startDate.setHours(0, 0, 0, 0);

    const orders = await this.prisma.order.findMany({
      where: {
        ...restaurantFilter,
        createdAt: { gte: startDate },
        status: { not: 'ANNULER' },
      },
      select: {
        total: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'asc' },
    });

    // Grouper par jour
    const dailyRevenue = new Map<string, { revenue: number; orders: number }>();

    // Initialiser tous les jours avec 0
    for (let i = 0; i < days; i++) {
      const date = new Date(startDate);
      date.setDate(startDate.getDate() + i);
      const dateKey = date.toISOString().split('T')[0];
      dailyRevenue.set(dateKey, { revenue: 0, orders: 0 });
    }

    // Ajouter les données réelles
    orders.forEach((order) => {
      const dateKey = order.createdAt.toISOString().split('T')[0];
      const current = dailyRevenue.get(dateKey) || { revenue: 0, orders: 0 };
      dailyRevenue.set(dateKey, {
        revenue: current.revenue + order.total,
        orders: current.orders + 1,
      });
    });

    const chartData = Array.from(dailyRevenue.entries()).map(([date, data]) => ({
      date,
      revenue: data.revenue,
      orders: data.orders,
    }));

    return {
      data: chartData,
    };
  }

  /**
   * Récupère les heures de pointe
   */
  async getPeakHours(firebaseUid: string, period?: string) {
    const restaurant = await this.common.getRestaurant(firebaseUid);
    const restaurantFilter = restaurant ? { restaurantId: restaurant.id } : {};

    const dateFilter = this.common.getDateFilter(period);

    const orders = await this.prisma.order.findMany({
      where: {
        ...restaurantFilter,
        status: { not: 'ANNULER' },
        ...(dateFilter && { createdAt: { gte: dateFilter } }),
      },
      select: {
        createdAt: true,
      },
    });

    // Grouper par heure
    const hourlyStats = new Array(24).fill(0).map((_, hour) => ({
      hour,
      count: 0,
    }));

    orders.forEach((order) => {
      const hour = order.createdAt.getHours();
      hourlyStats[hour].count++;
    });

    return {
      data: hourlyStats,
      peakHour: hourlyStats.reduce((max, current) =>
        current.count > max.count ? current : max
      ),
    };
  }

  /**
   * Classement des restaurants par revenu (ADMIN uniquement)
   */
  async getRestaurantRanking(period?: string) {
    const dateFilter = this.common.getDateFilter(period);

    // 1 seul groupBy au lieu de N requêtes aggregate
    const revenueByRestaurant = await this.prisma.order.groupBy({
      by: ['restaurantId'],
      where: {
        status: { not: 'ANNULER' },
        ...(dateFilter && { createdAt: { gte: dateFilter } }),
      },
      _sum: { total: true },
      _count: { id: true },
    });

    const restaurantIds = revenueByRestaurant.map((r) => r.restaurantId);
    const revenueMap = new Map(
      revenueByRestaurant.map((r) => [r.restaurantId, r]),
    );

    const restaurants = await this.prisma.restaurant.findMany({
      where: { id: { in: restaurantIds } },
      select: { id: true, nom: true, imageUrl: true, isActive: true },
    });

    const ranked = restaurants
      .map((r) => ({
        ...r,
        orderCount: revenueMap.get(r.id)?._count.id ?? 0,
        totalRevenue: revenueMap.get(r.id)?._sum.total ?? 0,
      }))
      .sort((a, b) => b.totalRevenue - a.totalRevenue);

    return { data: ranked };
  }
}
