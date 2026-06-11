/* eslint-disable prettier/prettier */
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AddToCartDto } from './dto/add-to-cart.dto';
import { UpdateCartItemDto } from './dto/update-cart-item.dto';
import { AddMenuToCartDto } from './dto/add-menu-to-cart.dto';
import { CartCommonService } from './cart-common.service';
import { CartItemsService } from './cart-items.service';
import { CartMenusService } from './cart-menus.service';

/**
 * Façade panier (LIL-147).
 *
 * Conserve l'API publique historique consommée par CartController. `getCart`
 * et `clearCart` restent ici ; les opérations sur les articles et les menus
 * sont déléguées à CartItemsService / CartMenusService (helpers partagés dans
 * CartCommonService).
 */
@Injectable()
export class CartService {
  constructor(
    private prisma: PrismaService,
    private readonly common: CartCommonService,
    private readonly items: CartItemsService,
    private readonly menus: CartMenusService,
  ) {}

  // ─── Articles ──────────────────────────────────────────────────────────────

  addItem(firebaseUid: string, dto: AddToCartDto) {
    return this.items.addItem(firebaseUid, dto);
  }

  updateItemQuantity(firebaseUid: string, cartItemId: string, dto: UpdateCartItemDto) {
    return this.items.updateItemQuantity(firebaseUid, cartItemId, dto);
  }

  removeItem(firebaseUid: string, cartItemId: string) {
    return this.items.removeItem(firebaseUid, cartItemId);
  }

  // ─── Menus ─────────────────────────────────────────────────────────────────

  addMenu(firebaseUid: string, dto: AddMenuToCartDto) {
    return this.menus.addMenu(firebaseUid, dto);
  }

  updateMenuQuantity(firebaseUid: string, menuId: string, dto: UpdateCartItemDto) {
    return this.menus.updateMenuQuantity(firebaseUid, menuId, dto);
  }

  removeMenu(firebaseUid: string, menuId: string) {
    return this.menus.removeMenu(firebaseUid, menuId);
  }

  // ─── Lecture & vidage ──────────────────────────────────────────────────────

  /**
   * Récupère le contenu complet du panier de l'utilisateur.
   */
  getCart(firebaseUid: string) {
    return this.common.getCart(firebaseUid);
  }

  /**
   * Vide complètement le panier de l'utilisateur.
   */
  async clearCart(firebaseUid: string) {
    const user = await this.common.getUserOrThrow(firebaseUid);

    const cart = await this.prisma.cart.findUnique({
      where: { userId: user.id },
    });
    if (!cart) return; // Le panier est déjà vide

    return this.prisma.cartItem.deleteMany({
      where: { cartId: cart.id },
    });
  }
}
