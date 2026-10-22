import { ForbiddenException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { startOfPeriod } from './brazzaville-time';

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
   * Début de la période, à l'heure de Brazzaville (DASH-03, Lot 5).
   */
  getDateFilter(period?: string): Date | null {
    return startOfPeriod(period);
  }
}
