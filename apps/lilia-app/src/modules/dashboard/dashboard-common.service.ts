import { ForbiddenException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { startOfPeriod } from './brazzaville-time';
import { VendorSubscriptionService } from '../subscriptions/vendor-subscription.service';
import { hasEntitlement } from '../subscriptions/entitlements';
import type { Entitlement } from '../subscriptions/plans';

/**
 * Retours produit, lot D (D3) — droit qui ouvre les produits phares et les
 * heures de pointe. Sans lui, le serveur ne livre plus ces données.
 */
export const ADVANCED_ANALYTICS_ENTITLEMENT: Entitlement = 'ANALYTICS_ADVANCED';

/**
 * Helpers analytics partagés (extrait de DashboardService — LIL-142).
 *
 * Résolution du périmètre (restaurant du restaurateur, ou global pour ADMIN)
 * et calcul du filtre de période, utilisés par les services de stats par
 * domaine (ventes, clients, catalogue).
 */
@Injectable()
export class DashboardCommonService {
  constructor(
    private prisma: PrismaService,
    private readonly subscriptions: VendorSubscriptionService,
  ) {}

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
   * Le périmètre résolu par `getRestaurant` a-t-il droit aux statistiques
   * avancées ? ADMIN (`null`, stats globales) : toujours. Vendeur : verdict
   * d'abonnement relu à chaque appel — jamais un drapeau envoyé par le client.
   */
  async hasAdvancedAnalytics(
    restaurant: { id: string } | null,
    now: Date = new Date(),
  ): Promise<boolean> {
    if (!restaurant) return true;
    const verdict = await this.subscriptions.verdictFor(restaurant.id, now);
    return hasEntitlement(verdict, ADVANCED_ANALYTICS_ENTITLEMENT);
  }

  /**
   * Début de la période, à l'heure de Brazzaville (DASH-03, Lot 5).
   */
  getDateFilter(period?: string): Date | null {
    return startOfPeriod(period);
  }
}
