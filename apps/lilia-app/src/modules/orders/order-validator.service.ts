/* eslint-disable prettier/prettier */
// orders/order-validator.service.ts
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { OnboardingStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { unavailabilityReason } from '../products/product-availability';
import { PromoService } from '../promo/promo.service';

@Injectable()
export class OrderValidatorService {
  constructor(private readonly prisma: PrismaService, private readonly promoService: PromoService) {}

  async validateAndGetUser(firebaseUid: string) {
    const user = await this.prisma.user.findUnique({
      where: { firebaseUid },
      include: {
        cart: {
          include: {
            items: {
              include: {
                product: true,
                variant: true,
                menu: { select: { id: true, nom: true, prix: true } },
              },
            },
          },
        },
      },
    });
    if (!user) throw new NotFoundException('Utilisateur non trouvé.');
    return user;
  }

  validateCartNotEmpty(cartItems: any[]) {
    if (!cartItems || cartItems.length === 0)
      throw new BadRequestException('Votre panier est vide.');
  }

  validateSameRestaurant(cartItems: any[]): string {
    const restaurantId = cartItems[0].product.restaurantId;
    const allSame = cartItems.every(
      (item) => item.product.restaurantId === restaurantId,
    );
    if (!allSame)
      throw new BadRequestException(
        'Tous les articles doivent provenir du même restaurant.',
      );
    return restaurantId;
  }

  async validateRestaurantOpen(restaurantId: string) {
    const restaurant = await this.prisma.restaurant.findUnique({
      where: { id: restaurantId },
    });
    if (!restaurant) throw new NotFoundException('Restaurant non trouvé.');
    if (
      !restaurant.isActive ||
      !restaurant.adminApproved ||
      restaurant.onboardingStatus !== OnboardingStatus.ACTIVATED
    ) {
      // Défense en profondeur : le catalogue ne devrait pas exposer ces vendeurs,
      // mais un panier obsolète peut encore les référencer. `onboardingStatus`
      // couvre le cas d'un vendeur remis en configuration après avoir été
      // publié — sa boutique disparaît du catalogue, mais les paniers déjà
      // constitués la référencent toujours.
      throw new BadRequestException(
        `"${restaurant.nom}" n'est plus disponible sur la plateforme.`,
      );
    }
    if (!restaurant.isOpen)
      throw new BadRequestException(
        `Le restaurant "${restaurant.nom}" est actuellement fermé.`,
      );
    return restaurant;
  }

  // Clé du fix : on récupère TOUS les produits d'un coup, pas en boucle
  async validateStock(cartItems: any[]) {
    const productIds = [...new Set(cartItems.map((i) => i.productId))];
    const menuIds = [...new Set(cartItems.filter((i) => i.menuId).map((i) => i.menuId))];

    const [products, menus] = await Promise.all([
      this.prisma.product.findMany({ where: { id: { in: productIds } } }),
      menuIds.length
        ? this.prisma.menuDuJour.findMany({ where: { id: { in: menuIds } } })
        : Promise.resolve([]),
    ]);

    const productMap = new Map(products.map((p) => [p.id, p]));
    const menuMap = new Map(menus.map((m) => [m.id, m]));
    const errors: string[] = [];

    for (const item of cartItems) {
      const product = productMap.get(item.productId);

      // Fixes M1 + M2 : produit retiré du catalogue, marqué indisponible, ou
      // hors de sa fenêtre horaire. Le catalogue les masque déjà, mais un
      // panier peut avoir été rempli avant — et `availableFrom/Until` n'était
      // jamais relu nulle part, donc une viennoiserie du matin passait
      // commande à 3 h.
      if (product) {
        const reason = unavailabilityReason(product);
        if (reason) errors.push(reason);
      }

      if (product?.stockRestant !== null && product?.stockRestant !== undefined) {
        if (product.stockRestant < item.quantite) {
          errors.push(
            product.stockRestant === 0
              ? `"${product.nom}" est épuisé`
              : `"${product.nom}" : seulement ${product.stockRestant} restant(s)`,
          );
        }
      }
      if (item.menuId) {
        const menu = menuMap.get(item.menuId);
        if (menu?.stockRestant !== null && menu?.stockRestant !== undefined) {
          if (menu.stockRestant < item.quantite) {
            errors.push(
              menu.stockRestant === 0
                ? `Menu "${menu.nom}" épuisé`
                : `Menu "${menu.nom}" : seulement ${menu.stockRestant} restant(s)`,
            );
          }
        }
      }
    }

    if (errors.length > 0)
      throw new BadRequestException(`Ruptures de stock : ${errors.join(', ')}`);
  }

  validateMinimumOrderAmount(subTotal: number, minimum: number, restaurantName: string) {
    if (minimum > 0 && subTotal < minimum)
      throw new BadRequestException(
        `Montant minimum pour ${restaurantName} : ${minimum} FCFA. Votre panier : ${subTotal} FCFA.`,
      );
  }
  // ─── Promo ─────────────────────────────────────────────────────────────────────
  async validatePromoCode(
    code: string,
    userId: string,
    restaurantId: string,
    subTotal: number,
    deliveryFee: number,
  ) {
    return this.promoService.validateCode(code, userId, restaurantId, subTotal, deliveryFee);
  }
}
//
