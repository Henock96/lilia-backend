/* eslint-disable prettier/prettier */
// orders/order-validator.service.ts
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
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

  async validateDeliveryAddress(adresseId: string, userId: string) {
    const address = await this.prisma.adresses.findUnique({
      where: { id: adresseId },
    });
    if (!address) throw new NotFoundException("Adresse de livraison introuvable.");
    if (address.userId !== userId)
      throw new ForbiddenException('Cette adresse ne vous appartient pas.');
    return `${address.rue}, ${address.ville}, ${address.country}`;
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
