/* eslint-disable prettier/prettier */
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

export const CART_INCLUDE = {
  items: {
    include: {
      // `madeToOrder` exposé pour que le client puisse afficher la modal
      // de conflit (LIL-122 décision 2a) avant d'appeler addItem.
      product: {
        select: {
          nom: true,
          imageUrl: true,
          restaurantId: true,
          madeToOrder: true,
        },
      },
      variant: { select: { label: true, prix: true } },
      menu: { select: { id: true, nom: true, prix: true, imageUrl: true } },
    },
  },
} as const;

/**
 * Helpers partagés du panier (extrait de CartService — LIL-147).
 *
 * Résolution user/cart, garde-fous (même restaurant, même mode
 * immédiat/sur-commande) et lecture du panier complet. Consommé par
 * CartItemsService et CartMenusService.
 */
@Injectable()
export class CartCommonService {
  constructor(private prisma: PrismaService) {}

  /**
   * Récupère ou crée le panier d'un utilisateur.
   */
  async getOrCreateCart(userId: string) {
    // upsert = getOrCreate en 1 seule requête SQL
    return this.prisma.cart.upsert({
      where: { userId },
      create: { userId },
      update: {},
    });
  }

  async getUserOrThrow(firebaseUid: string) {
    const user = await this.prisma.user.findUnique({ where: { firebaseUid } });
    if (!user) throw new NotFoundException('Utilisateur non trouvé.');
    return user;
  }

  async getCartOrThrow(userId: string) {
    const cart = await this.prisma.cart.findUnique({ where: { userId } });
    if (!cart) throw new NotFoundException('Panier non trouvé.');
    return cart;
  }

  assertSameRestaurant(
    cartItems: { product: { restaurantId: string } }[],
    incomingRestaurantId: string,
  ) {
    if (
      cartItems.length > 0 &&
      cartItems[0].product.restaurantId !== incomingRestaurantId
    ) {
      throw new BadRequestException(
        'Vous ne pouvez commander que dans un seul restaurant à la fois. Veuillez vider votre panier.',
      );
    }
  }

  /**
   * LIL-121 (décision 2a) : un panier = un slot. On interdit de mélanger des
   * produits immédiats (`madeToOrder=false`) et des produits sur commande
   * (`madeToOrder=true`) dans le même panier — sinon le checkout devrait
   * gérer un slot/un timing par item, ce qu'on n'a pas voulu pour le MVP.
   *
   * Defense in depth : le frontend doit bloquer aussi côté UX (modal), mais
   * on protège ici contre n'importe quel client API qui contournerait.
   */
  assertSameMadeToOrderMode(
    cartItems: { product: { madeToOrder: boolean } }[],
    incomingMadeToOrder: boolean,
  ) {
    if (cartItems.length === 0) return;
    const existingMadeToOrder = cartItems[0].product.madeToOrder;
    if (existingMadeToOrder !== incomingMadeToOrder) {
      throw new BadRequestException(
        incomingMadeToOrder
          ? 'Votre panier contient déjà des produits immédiats. Pour ajouter ce produit sur commande, terminez la commande en cours ou videz votre panier.'
          : 'Votre panier contient déjà des produits sur commande. Pour ajouter ce produit immédiat, terminez la commande en cours ou videz votre panier.',
      );
    }
  }

  /**
   * Récupère le contenu complet du panier de l'utilisateur.
   */
  async getCart(firebaseUid: string) {
    const user = await this.getUserOrThrow(firebaseUid);
    const cart = await this.getCartOrThrow(user.id);

    return this.prisma.cart.findUnique({
      where: { id: cart.id },
      include: CART_INCLUDE,
    });
  }
}
