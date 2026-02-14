/* eslint-disable prettier/prettier */
import { ForbiddenException, Injectable } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';

@Injectable()
export class DashboardService {
  constructor(private prisma: PrismaService) {}

  /**
   * Récupère le restaurant de l'utilisateur ou null si ADMIN (stats globales)
   */
  private async getRestaurant(firebaseUid: string) {
    const user = await this.prisma.user.findUnique({ where: { firebaseUid } });
    if (!user) throw new ForbiddenException('Utilisateur non trouvé.');

    if (user.role === 'ADMIN') {
      return null; // ADMIN = stats globales
    }

    const restaurant = await this.prisma.restaurant.findFirst({
      where: { owner: { firebaseUid } },
    });

    if (!restaurant) {
      throw new ForbiddenException('Vous devez posséder un restaurant.');
    }

    return restaurant;
  }

  /**
   * Récupère les statistiques générales du dashboard
   */
  async getOverview(firebaseUid: string) {
    const restaurant = await this.getRestaurant(firebaseUid);
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
    const restaurant = await this.getRestaurant(firebaseUid);
    const restaurantFilter = restaurant ? { restaurantId: restaurant.id } : {};

    const dateFilter = this.getDateFilter(period);

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
   * Récupère les produits les plus vendus
   */
  async getTopProducts(firebaseUid: string, limit = 10, period?: string) {
    const restaurant = await this.getRestaurant(firebaseUid);
    const restaurantFilter = restaurant ? { restaurantId: restaurant.id } : {};

    const dateFilter = this.getDateFilter(period);

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
   * Récupère l'évolution des revenus par jour
   */
  async getRevenueChart(firebaseUid: string, days = 30) {
    const restaurant = await this.getRestaurant(firebaseUid);
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
   * Récupère les statistiques des clients
   */
  async getClientStats(firebaseUid: string) {
    const restaurant = await this.getRestaurant(firebaseUid);
    const restaurantFilter = restaurant ? { restaurantId: restaurant.id } : {};

    const today = new Date();
    const startOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
    const startOfLastMonth = new Date(today.getFullYear(), today.getMonth() - 1, 1);

    // Clients ce mois-ci
    const thisMonthClients = await this.prisma.order.findMany({
      where: {
        ...restaurantFilter,
        createdAt: { gte: startOfMonth },
      },
      select: { userId: true },
      distinct: ['userId'],
    });

    // Clients le mois dernier
    const lastMonthClients = await this.prisma.order.findMany({
      where: {
        ...restaurantFilter,
        createdAt: {
          gte: startOfLastMonth,
          lt: startOfMonth,
        },
      },
      select: { userId: true },
      distinct: ['userId'],
    });

    // Top clients (par nombre de commandes)
    const topClients = await this.prisma.order.groupBy({
      by: ['userId'],
      where: {
        ...restaurantFilter,
        status: { not: 'ANNULER' },
      },
      _count: { userId: true },
      _sum: { total: true },
      orderBy: { _sum: { total: 'desc' } },
      take: 10,
    });

    // Récupérer les détails des top clients
    const clientIds = topClients.map((c) => c.userId);
    const clients = await this.prisma.user.findMany({
      where: { id: { in: clientIds } },
      select: {
        id: true,
        nom: true,
        email: true,
        imageUrl: true,
      },
    });

    const clientsMap = new Map(clients.map((c) => [c.id, c]));

    // Nouveaux clients ce mois
    const thisMonthClientIds = new Set(thisMonthClients.map((c) => c.userId));
    const lastMonthClientIds = new Set(lastMonthClients.map((c) => c.userId));
    const newClients = [...thisMonthClientIds].filter((id) => !lastMonthClientIds.has(id));

    // Clients fidèles (ont commandé ce mois et le mois dernier)
    const returningClients = [...thisMonthClientIds].filter((id) => lastMonthClientIds.has(id));

    return {
      data: {
        thisMonth: {
          total: thisMonthClients.length,
          new: newClients.length,
          returning: returningClients.length,
        },
        lastMonth: {
          total: lastMonthClients.length,
        },
        growth: lastMonthClients.length > 0
          ? (((thisMonthClients.length - lastMonthClients.length) / lastMonthClients.length) * 100).toFixed(1)
          : 100,
        topClients: topClients.map((tc, index) => ({
          rank: index + 1,
          client: clientsMap.get(tc.userId),
          orderCount: tc._count.userId,
          totalSpent: tc._sum.total || 0,
        })),
      },
    };
  }

  /**
   * Récupère les heures de pointe
   */
  async getPeakHours(firebaseUid: string, period?: string) {
    const restaurant = await this.getRestaurant(firebaseUid);
    const restaurantFilter = restaurant ? { restaurantId: restaurant.id } : {};

    const dateFilter = this.getDateFilter(period);

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
    const dateFilter = this.getDateFilter(period);

    const restaurants = await this.prisma.restaurant.findMany({
      select: {
        id: true,
        nom: true,
        imageUrl: true,
        isActive: true,
        _count: { select: { orders: true } },
      },
    });

    const rankings = await Promise.all(
      restaurants.map(async (r) => {
        const revenue = await this.prisma.order.aggregate({
          where: {
            restaurantId: r.id,
            status: { not: 'ANNULER' },
            ...(dateFilter && { createdAt: { gte: dateFilter } }),
          },
          _sum: { total: true },
          _count: { id: true },
        });

        return {
          id: r.id,
          nom: r.nom,
          imageUrl: r.imageUrl,
          isActive: r.isActive,
          orderCount: revenue._count.id,
          totalRevenue: revenue._sum.total || 0,
        };
      }),
    );

    rankings.sort((a, b) => b.totalRevenue - a.totalRevenue);

    return {
      data: rankings,
    };
  }

  /**
   * Helper pour obtenir le filtre de date
   */
  private getDateFilter(period?: string): Date | null {
    if (!period) return null;

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    switch (period) {
      case 'today':
        return today;
      case 'week':
        const startOfWeek = new Date(today);
        startOfWeek.setDate(today.getDate() - today.getDay());
        return startOfWeek;
      case 'month':
        return new Date(today.getFullYear(), today.getMonth(), 1);
      case 'year':
        return new Date(today.getFullYear(), 0, 1);
      default:
        return null;
    }
  }
}
