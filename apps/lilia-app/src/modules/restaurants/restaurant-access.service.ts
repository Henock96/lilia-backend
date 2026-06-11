/* eslint-disable prettier/prettier */
import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Contrôle de propriété restaurant (extrait de RestaurantsService — LIL-145).
 *
 * Helper partagé par les mutations (RestaurantsService) et la gestion des
 * horaires (RestaurantHoursService), évitant la duplication et toute
 * dépendance circulaire entre ces services.
 */
@Injectable()
export class RestaurantAccessService {
  constructor(private prisma: PrismaService) {}

  /**
   * Vérifie que l'utilisateur est propriétaire du restaurant (ou ADMIN).
   *
   * SÉCURITÉ (fix B1) : l'autorisation se base sur le rôle de l'APPELANT
   * (caller.role), PAS sur celui du propriétaire du restaurant. Sinon un
   * RESTAURATEUR pourrait modifier le restaurant d'un autre dont le owner
   * est ADMIN — IDOR. Voir vendors.service.ts:186-195 pour le même pattern.
   */
  async verifyOwnership(restaurantId: string, firebaseUid: string) {
    const restaurant = await this.prisma.restaurant.findUnique({
      where: { id: restaurantId },
      include: { owner: { select: { firebaseUid: true } } },
    });

    if (!restaurant) throw new NotFoundException('Restaurant non trouvé');

    // L'autorisation se fait sur le rôle de l'APPELANT, pas sur celui du
    // propriétaire (sinon IDOR : si owner.role === ADMIN, n'importe qui
    // pourrait modifier le restaurant — et un vrai ADMIN appelant serait
    // refusé sur les restos d'autrui).
    const isOwner = restaurant.owner.firebaseUid === firebaseUid;
    if (isOwner) return restaurant;

    const caller = await this.prisma.user.findUnique({
      where: { firebaseUid },
      select: { role: true },
    });
    if (caller?.role === 'ADMIN') return restaurant;

    throw new ForbiddenException("Vous n'êtes pas autorisé à modifier ce restaurant");
  }
}
