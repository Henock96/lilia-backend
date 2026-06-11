/* eslint-disable prettier/prettier */
import { ForbiddenException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Helpers analytics partagés (extrait de DashboardService — LIL-142).
 *
 * Résolution du périmètre (restaurant du restaurateur, ou global pour ADMIN)
 * et calcul du filtre de période, utilisés par les services de stats par
 * domaine (ventes, clients, catalogue).
 */
@Injectable()
export class DashboardCommonService {
  constructor(private prisma: PrismaService) {}

  /**
   * Récupère le restaurant de l'utilisateur ou null si ADMIN (stats globales)
   */
  async getRestaurant(firebaseUid: string) {
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
   * Helper pour obtenir le filtre de date
   */
  getDateFilter(period?: string): Date | null {
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
