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

    // ⚠️ AGRÉGATION PAR PRODUIT — fix S-9 (audit du 05/09/2026).
    //
    // La boucle parcourait les **lignes** de panier et comparait chacune au
    // stock, isolément. Un produit présent sur deux lignes (deux variantes du
    // même plat) était donc validé deux fois contre le même stock : deux fois
    // 1 unité passaient sur un stock de 1. La décrémentation, elle, agrège par
    // produit — elle refusait ensuite l'écriture, si bien que la commande
    // échouait quand même, mais sur « Stock épuisé pour un ou plusieurs
    // produits », après le travail de la transaction, au lieu du message
    // nominatif que cette méthode existe pour produire.
    //
    // Le validateur doit compter comme la décrémentation compte, sinon les
    // deux ne parlent pas du même panier.
    const qtyByProduct = new Map<string, number>();
    const qtyByMenu = new Map<string, number>();
    for (const item of cartItems) {
      qtyByProduct.set(
        item.productId,
        (qtyByProduct.get(item.productId) ?? 0) + item.quantite,
      );
      if (item.menuId) {
        qtyByMenu.set(
          item.menuId,
          (qtyByMenu.get(item.menuId) ?? 0) + item.quantite,
        );
      }
    }

    for (const [productId, quantite] of qtyByProduct) {
      const product = productMap.get(productId);
      if (!product) continue;

      // Fixes M1 + M2 (+ S-2) : produit retiré du catalogue, marqué
      // indisponible, hors de sa fenêtre horaire, ou en stock insuffisant. Le
      // catalogue masque déjà les trois premiers, mais un panier peut avoir
      // été rempli avant — et `availableFrom/Until` n'était relu nulle part,
      // donc une viennoiserie du matin passait commande à 3 h.
      //
      // Les quatre raisons vivent dans `unavailabilityReason` : le panier et
      // le checkout posent ainsi exactement la même question, avec les mêmes
      // mots. Elles étaient auparavant réparties entre cette méthode et cette
      // fonction, ce qui donnait deux messages différents pour « épuisé ».
      const reason = unavailabilityReason(product, new Date(), quantite);
      if (reason) errors.push(reason);
    }

    for (const [menuId, quantite] of qtyByMenu) {
      const menu = menuMap.get(menuId);
      if (menu?.stockRestant !== null && menu?.stockRestant !== undefined) {
        if (menu.stockRestant < quantite) {
          errors.push(
            menu.stockRestant === 0
              ? `Menu « ${menu.nom} » épuisé.`
              : `Menu « ${menu.nom} » : il ne reste que ${menu.stockRestant} unité${menu.stockRestant > 1 ? 's' : ''}.`,
          );
        }
      }
    }

    if (errors.length > 0)
      throw new BadRequestException(`Ruptures de stock : ${errors.join(' ')}`);
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
