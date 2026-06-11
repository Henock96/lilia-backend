/* eslint-disable prettier/prettier */
import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { DashboardCommonService } from './dashboard-common.service';

/**
 * Statistiques clients (extrait de DashboardService — LIL-142).
 * Vue d'ensemble clients (nouveaux / fidèles / top dépensiers) et détail
 * complet d'un client.
 */
@Injectable()
export class DashboardClientsStatsService {
  constructor(
    private prisma: PrismaService,
    private readonly common: DashboardCommonService,
  ) {}

  /**
   * Récupère les statistiques des clients
   */
  async getClientStats(firebaseUid: string) {
    const restaurant = await this.common.getRestaurant(firebaseUid);
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
        phone: true,
        imageUrl: true,
        createdAt: true,
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
   * Détail complet d'un client pour un restaurateur
   */
  async getClientDetail(firebaseUid: string, clientId: string) {
    const restaurant = await this.common.getRestaurant(firebaseUid);
    const restaurantFilter = restaurant ? { restaurantId: restaurant.id } : {};

    const [client, orders] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: clientId },
        select: {
          id: true,
          nom: true,
          email: true,
          phone: true,
          imageUrl: true,
          createdAt: true,
          loyaltyPoints: true,
          referralCode: true,
          referredByCode: true,
          adresses: {
            select: { rue: true, ville: true, etat: true, isDefault: true },
            take: 5,
          },
        },
      }),
      this.prisma.order.findMany({
        where: { ...restaurantFilter, userId: clientId, status: { not: 'ANNULER' } },
        orderBy: { createdAt: 'desc' },
        take: 20,
        select: {
          id: true,
          total: true,
          status: true,
          createdAt: true,
          isDelivery: true,
          deliveryAddress: true,
          items: {
            select: {
              quantite: true,
              prix: true,
              product: { select: { nom: true } },
            },
          },
        },
      }),
    ]);

    if (!client) throw new NotFoundException('Client introuvable');

    const totalSpent = orders.reduce((s, o) => s + (o.total ?? 0), 0);
    const lastOrder = orders[0] ?? null;

    return {
      data: {
        client,
        stats: {
          orderCount: orders.length,
          totalSpent,
          averageOrder: orders.length > 0 ? Math.round(totalSpent / orders.length) : 0,
          lastOrderAt: lastOrder?.createdAt ?? null,
        },
        recentOrders: orders,
      },
    };
  }
}
