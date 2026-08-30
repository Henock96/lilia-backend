/* eslint-disable prettier/prettier */
import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { VendorType } from '@prisma/client';
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

  /**
   * Détermine le vendeur cible d'une écriture au catalogue (produit, menu).
   *
   * Le comportement historique — « le vendeur dont je suis propriétaire » —
   * était le seul possible, et il enfermait l'administrateur dans une
   * contradiction : les contrôleurs de `POST /products` et `POST /menus`
   * l'autorisent par `@Roles('RESTAURATEUR', 'ADMIN')`, mais le service lui
   * renvoyait « Vous devez posséder un restaurant pour créer un produit ». Un
   * admin ne pouvait donc pas amorcer la boutique qu'il venait de créer, ni
   * dépanner un vendeur en difficulté.
   *
   * Sans `restaurantId`, rien ne change. Avec, seul un ADMIN passe — et
   * l'appelant est chargé de tracer le geste dans `AdminAuditLog`.
   */
  async resolveTargetRestaurant(
    firebaseUid: string,
    restaurantId?: string,
  ): Promise<{ id: string; vendorType: VendorType; onBehalfOf: boolean }> {
    if (!restaurantId) {
      const own = await this.prisma.restaurant.findFirst({
        where: { owner: { firebaseUid } },
        select: { id: true, vendorType: true },
      });
      if (!own) {
        throw new ForbiddenException(
          'Vous devez posséder un vendeur pour créer un produit ou un menu.',
        );
      }
      return { ...own, onBehalfOf: false };
    }

    const caller = await this.prisma.user.findUnique({
      where: { firebaseUid },
      select: { role: true },
    });
    if (caller?.role !== 'ADMIN') {
      throw new ForbiddenException(
        "Seul un administrateur peut écrire dans le catalogue d'un autre vendeur.",
      );
    }

    const target = await this.prisma.restaurant.findUnique({
      where: { id: restaurantId },
      select: { id: true, vendorType: true },
    });
    if (!target) throw new NotFoundException('Vendeur introuvable.');
    return { ...target, onBehalfOf: true };
  }
}
