/* eslint-disable prettier/prettier */
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AddToCartDto } from './dto/add-to-cart.dto';
import { UpdateCartItemDto } from './dto/update-cart-item.dto';
import { CartCommonService } from './cart-common.service';
import { unavailabilityReason } from '../products/product-availability';

/**
 * Opérations panier sur les articles individuels (extrait de CartService —
 * LIL-147) : ajout, mise à jour de quantité, suppression.
 */
@Injectable()
export class CartItemsService {
  constructor(
    private prisma: PrismaService,
    private readonly common: CartCommonService,
  ) {}

  /**
   * Ajoute un article individuel au panier ou met à jour sa quantité.
   * Vérifie que tous les articles du panier proviennent du même restaurant.
   */
  async addItem(firebaseUid: string, dto: AddToCartDto) {
    const user = await this.common.getUserOrThrow(firebaseUid);
    const variant = await this.prisma.productVariant.findUnique({
      where: { id: dto.variantId },
      include: { product: true },
    });
    if (!variant)
      throw new NotFoundException('Variante de produit non trouvée.');

    const cart = await this.common.getOrCreateCart(user.id);

    const cartItems = await this.prisma.cartItem.findMany({
      where: { cartId: cart.id },
      include: { product: true },
    });

    this.common.assertSameRestaurant(cartItems, variant.product.restaurantId);
    this.common.assertSameMadeToOrderMode(cartItems, variant.product.madeToOrder);

    // Chercher un item individuel existant (menuId = null)
    const existingItem = await this.prisma.cartItem.findFirst({
      where: {
        cartId: cart.id,
        variantId: dto.variantId,
        menuId: null,
      },
    });

    // Fixes M1 + M2 + S-2 : produit retiré du catalogue, marqué indisponible,
    // hors de sa fenêtre horaire, ou stock insuffisant — refusé ici plutôt
    // qu'au checkout.
    //
    // ⚠️ La quantité contrôlée est le **total du panier après ajout**, pas
    // celle de la requête. Ajouter 1 unité dix fois de suite est le geste
    // ordinaire d'un client sur mobile : ne valider que l'incrément laisserait
    // passer n'importe quel total, un ajout à la fois.
    //
    // Et elle couvre **toutes les lignes du même produit**, variantes
    // comprises : c'est le produit qui porte le stock, pas la variante
    // (`ProductVariant` n'a aucune colonne de stock). Deux variantes du même
    // plat puisent dans le même compteur — la décrémentation du checkout le
    // sait déjà, le panier l'ignorait.
    const alreadyInCart = cartItems
      .filter((item) => item.productId === variant.productId)
      .reduce((sum, item) => sum + item.quantite, 0);

    const reason = unavailabilityReason(
      variant.product,
      new Date(),
      alreadyInCart + dto.quantite,
    );
    if (reason) throw new BadRequestException(reason);

    if (existingItem) {
      await this.prisma.cartItem.update({
        where: { id: existingItem.id },
        data: { quantite: existingItem.quantite + dto.quantite },
      });
    } else {
      await this.prisma.cartItem.create({
        data: {
          cartId: cart.id,
          productId: variant.productId,
          variantId: dto.variantId,
          quantite: dto.quantite,
        },
      });
    }

    return this.common.getCart(firebaseUid);
  }

  /**
   * Met à jour la quantité d'un article individuel dans le panier.
   * Rejette si l'article fait partie d'un menu.
   */
  async updateItemQuantity(
    firebaseUid: string,
    cartItemId: string,
    dto: UpdateCartItemDto,
  ) {
    const user = await this.common.getUserOrThrow(firebaseUid);

    const cartItem = await this.prisma.cartItem.findFirst({
      where: { id: cartItemId, cart: { userId: user.id } },
      include: { product: true },
    });

    if (!cartItem) {
      throw new ForbiddenException("Cet article n'est pas dans votre panier.");
    }

    if (cartItem.menuId) {
      throw new BadRequestException(
        "Cet article fait partie d'un menu. Utilisez la mise à jour du menu pour modifier la quantité.",
      );
    }

    // Fix S-2 : cette méthode ne vérifiait **rien**. `PATCH /cart/items/:id`
    // avec `{ quantite: 50 }` sur un produit dont il restait une unité
    // répondait 200 ; l'échec n'arrivait qu'au checkout, après la saisie de
    // l'adresse et du moyen de paiement.
    //
    // Le total contrôlé inclut les autres lignes du même produit — le stock
    // est porté par le produit, pas par la variante.
    const siblings = await this.prisma.cartItem.findMany({
      where: {
        cartId: cartItem.cartId,
        productId: cartItem.productId,
        id: { not: cartItemId },
      },
      select: { quantite: true },
    });
    const totalWanted =
      dto.quantite + siblings.reduce((sum, s) => sum + s.quantite, 0);

    const reason = unavailabilityReason(
      cartItem.product,
      new Date(),
      totalWanted,
    );
    if (reason) throw new BadRequestException(reason);

    // `UpdateCartItemDto` impose `@Min(1)` : la branche « quantite === 0 =
    // suppression » était du code mort, inatteignable depuis HTTP (fix L1).
    // Pour retirer un article, le client appelle DELETE /cart/items/:id.
    await this.prisma.cartItem.update({
      where: { id: cartItemId },
      data: { quantite: dto.quantite },
    });

    return this.common.getCart(firebaseUid);
  }

  /**
   * Supprime un article individuel du panier.
   * Rejette si l'article fait partie d'un menu.
   */
  async removeItem(firebaseUid: string, cartItemId: string) {
    const user = await this.common.getUserOrThrow(firebaseUid);

    const cartItem = await this.prisma.cartItem.findFirst({
      where: { id: cartItemId, cart: { userId: user.id } },
    });

    if (!cartItem) {
      throw new ForbiddenException("Cet article n'est pas dans votre panier.");
    }

    if (cartItem.menuId) {
      throw new BadRequestException(
        "Cet article fait partie d'un menu. Utilisez la suppression du menu pour le retirer.",
      );
    }

    await this.prisma.cartItem.delete({
      where: { id: cartItemId },
    });

    return this.common.getCart(firebaseUid);
  }
}
