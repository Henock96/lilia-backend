/* eslint-disable prettier/prettier */
// orders/order-validator.service.ts
import {
  closedMessage,
  formatUntil,
  VendorOpeningService,
} from '../vendors/vendor-opening.service';
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { OnboardingStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { unavailabilityReason } from '../products/product-availability';
import { PromoService } from '../promo/promo.service';
import { countMenus } from './menu-quantities';
import { CART_LINE_INCLUDE, type CartLine } from '../modifiers/cart-line-pricing';

/** Ce que les contrôles de restaurant lisent d'une ligne. */
type LineWithVendor = { product: { restaurantId: string } };
/** Ce que le contrôle de stock lit d'une ligne (sous-ensemble de `CartLine`). */
type StockLine = Pick<CartLine, 'productId' | 'menuId' | 'quantite'> &
  LineWithVendor;

@Injectable()
export class OrderValidatorService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly promoService: PromoService,
    private readonly opening: VendorOpeningService,
  ) {}

  async validateAndGetUser(firebaseUid: string) {
    const user = await this.prisma.user.findUnique({
      where: { firebaseUid },
      include: {
        cart: {
          // F3-09 — les options de chaque ligne et les groupes attachés à son
          // produit, chargés par lots : le checkout les résout sans aller-retour
          // supplémentaire par ligne.
          include: { items: { include: CART_LINE_INCLUDE } },
        },
      },
    });
    if (!user) throw new NotFoundException('Utilisateur non trouvé.');
    return user;
  }

  validateCartNotEmpty(cartItems: readonly unknown[]) {
    if (!cartItems || cartItems.length === 0)
      throw new BadRequestException('Votre panier est vide.');
  }

  validateSameRestaurant(cartItems: readonly LineWithVendor[]): string {
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
    // F3-03 — la règle d'ouverture est recalculée ici, pas lue dans la
    // colonne `isOpen` : celle-ci n'est rafraîchie que chaque minute par le
    // cron, et une boutique mise en pause prenait encore commande entre-temps
    // (écart E7).
    const decision = await this.opening.decide(restaurant.id);
    if (!decision.open) {
      throw new BadRequestException(closedMessage(restaurant.nom, decision));
    }
    return restaurant;
  }

  /**
   * F3-03, R-03.3 — une précommande dont l'échéance tombe dans une pause ou
   * un congé déclarés est refusée, en disant quand le vendeur rouvre. Un
   * vendeur en congés ne doit pas découvrir le jour de son retour une
   * commande qu'il n'a jamais pu préparer.
   */
  async validateScheduledNotClosed(
    restaurant: { id: string; nom: string },
    scheduledFor: Date | null | undefined,
  ) {
    if (!scheduledFor) return;
    const closure = await this.opening.datedClosureAt(restaurant.id, scheduledFor);
    if (closure) {
      throw new BadRequestException(
        `« ${restaurant.nom} » est fermé à la date choisie (jusqu'${formatUntil(closure.until)}). Choisissez un autre créneau.`,
      );
    }
  }

  // Clé du fix : on récupère TOUS les produits d'un coup, pas en boucle
  async validateStock(cartItems: readonly StockLine[]) {
    const productIds = [...new Set(cartItems.map((i) => i.productId))];
    const menuIds = [...new Set(cartItems.filter((i) => i.menuId).map((i) => i.menuId))];

    const [products, menus] = await Promise.all([
      this.prisma.product.findMany({ where: { id: { in: productIds } } }),
      menuIds.length
        ? this.prisma.menuDuJour.findMany({
            where: { id: { in: menuIds } },
            include: { products: { select: { productId: true } } },
          })
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
    for (const item of cartItems) {
      qtyByProduct.set(
        item.productId,
        (qtyByProduct.get(item.productId) ?? 0) + item.quantite,
      );
    }
    // Un menu = q unités, pas N × q — même comptage que le prix et la
    // décrémentation (fix F-01, `menu-quantities.ts`).
    const qtyByMenu = countMenus(cartItems);

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

    const now = new Date();
    for (const [menuId, quantite] of qtyByMenu) {
      const menu = menuMap.get(menuId);
      if (!menu) {
        errors.push('Un menu de votre panier a été retiré de la carte.');
        continue;
      }
      // ⚠️ Fix F-02 : l'ajout au panier ne réserve pas le menu. Entre l'ajout
      // et le paiement, le vendeur peut le désactiver, sa fenêtre peut se
      // fermer ou sa composition changer — et seul l'ajout le vérifiait. Un
      // « menu du jour » mis au panier à midi se vendait encore à minuit, au
      // prix du menu, alors que la cuisine ne le préparait plus.
      const reason = menuUnavailabilityReason(
        menu,
        cartItems.filter((i) => i.menuId === menuId).map((i) => i.productId),
        cartRestaurantId(cartItems),
        now,
      );
      if (reason) {
        errors.push(reason);
        continue;
      }
      if (menu.stockRestant !== null && menu.stockRestant !== undefined) {
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

/** Vendeur du panier : `validateSameRestaurant` a déjà garanti qu'il est unique. */
function cartRestaurantId(
  cartItems: readonly LineWithVendor[],
): string | undefined {
  return cartItems[0]?.product?.restaurantId;
}

/**
 * Pourquoi un menu du panier n'est-il plus achetable ? `null` s'il l'est.
 *
 * Revalide au checkout ce que `CartMenusService.addMenu` ne vérifiait qu'à
 * l'ajout (F-02) : menu actif, dans sa fenêtre, du même vendeur que le panier,
 * et **composé des mêmes produits** que lors de l'ajout — sinon le client
 * paierait le prix du menu pour un contenu qui n'est plus celui annoncé.
 *
 * Le prix, lui, n'est pas une raison de refus : il est relu en base au
 * checkout (`OrderCalculatorService`) et c'est ce prix-là qui est facturé.
 */
export function menuUnavailabilityReason(
  menu: {
    nom: string;
    isActive: boolean;
    dateDebut: Date;
    dateFin: Date;
    restaurantId: string;
    products: { productId: string }[];
  },
  cartProductIds: string[],
  restaurantId: string | undefined,
  now: Date,
): string | null {
  if (!menu.isActive) return `Menu « ${menu.nom} » n'est plus proposé.`;
  if (now < menu.dateDebut || now > menu.dateFin) {
    return `Menu « ${menu.nom} » n'est plus disponible à cette heure.`;
  }
  if (restaurantId && menu.restaurantId !== restaurantId) {
    return `Menu « ${menu.nom} » n'appartient pas à ce vendeur.`;
  }
  const expected = new Set(menu.products.map((p) => p.productId));
  const actual = new Set(cartProductIds);
  const sameComposition =
    expected.size === actual.size && [...expected].every((id) => actual.has(id));
  if (!sameComposition) {
    return `La composition du menu « ${menu.nom} » a changé : retirez-le du panier puis ajoutez-le de nouveau.`;
  }
  return null;
}
