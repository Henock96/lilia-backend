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

    // Fixes M1 + M2 : on refuse d'emblée un produit retiré du catalogue,
    // marqué indisponible ou hors de sa fenêtre horaire, plutôt que de le
    // laisser bloquer le checkout plus tard.
    const reason = unavailabilityReason(variant.product);
    if (reason) throw new BadRequestException(reason);

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
    });

    if (!cartItem) {
      throw new ForbiddenException("Cet article n'est pas dans votre panier.");
    }

    if (cartItem.menuId) {
      throw new BadRequestException(
        "Cet article fait partie d'un menu. Utilisez la mise à jour du menu pour modifier la quantité.",
      );
    }

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
