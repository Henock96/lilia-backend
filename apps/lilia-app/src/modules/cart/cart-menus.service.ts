/* eslint-disable prettier/prettier */
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { UpdateCartItemDto } from './dto/update-cart-item.dto';
import { AddMenuToCartDto } from './dto/add-menu-to-cart.dto';
import { CartCommonService } from './cart-common.service';

/**
 * Opérations panier sur les menus (extrait de CartService — LIL-147).
 *
 * Un menu est ajouté comme unité atomique : tous ses produits deviennent des
 * CartItem liés par `menuId`, mis à jour ou supprimés en groupe.
 */
@Injectable()
export class CartMenusService {
  constructor(
    private prisma: PrismaService,
    private readonly common: CartCommonService,
  ) {}

  /**
   * Ajoute un menu complet au panier comme unité atomique.
   * Tous les produits du menu sont ajoutés avec le menuId lié.
   */
  async addMenu(firebaseUid: string, dto: AddMenuToCartDto) {
    const user = await this.common.getUserOrThrow(firebaseUid);
    if (!user) throw new NotFoundException('Utilisateur non trouvé.');

    // Valider que le menu existe, est actif, et dans ses dates de validité
    const menu = await this.prisma.menuDuJour.findUnique({
      where: { id: dto.menuId },
      include: {
        products: {
          include: {
            product: {
              include: { variants: true },
            },
          },
          orderBy: { ordre: 'asc' },
        },
      },
    });

    if (!menu) throw new NotFoundException('Menu non trouvé.');
    if (!menu.isActive)
      throw new BadRequestException("Ce menu n'est plus actif.");

    const now = new Date();
    if (now < menu.dateDebut || now > menu.dateFin) {
      throw new BadRequestException(
        "Ce menu n'est pas disponible actuellement.",
      );
    }

    if (menu.products.length === 0) {
      throw new BadRequestException('Ce menu ne contient pas de produits.');
    }
    // ✅ Validation AVANT la transaction — throw propre
    const missingVariant = menu.products.find(
      (mp) => mp.product.variants.length === 0,
    );
    if (missingVariant) {
      throw new BadRequestException(
        `Le produit "${missingVariant.product.nom}" n'a pas de variante disponible.`,
      );
    }

    const cart = await this.common.getOrCreateCart(user.id);

    // Vérifier la contrainte du même restaurant
    const cartItems = await this.prisma.cartItem.findMany({
      where: { cartId: cart.id },
      include: { product: true },
    });

    this.common.assertSameRestaurant(cartItems, menu.restaurantId);
    // Un menu est composé de produits — si l'un d'eux est madeToOrder, on
    // refuse de mélanger avec un panier d'immédiats. En pratique les menus
    // sont des combos restaurant (immédiats), mais on protège quand même.
    const menuHasMadeToOrder = menu.products.some(
      (mp) => mp.product.madeToOrder,
    );
    this.common.assertSameMadeToOrderMode(cartItems, menuHasMadeToOrder);

    // Vérifier si le menu est déjà dans le panier
    const existingMenuItems = await this.prisma.cartItem.findMany({
      where: { cartId: cart.id, menuId: dto.menuId },
    });

    if (existingMenuItems.length > 0) {
      // Incrémenter la quantité de tous les items du menu
      await this.prisma.$transaction(
        existingMenuItems.map((item) =>
          this.prisma.cartItem.update({
            where: { id: item.id },
            data: { quantite: item.quantite + dto.quantite },
          }),
        ),
      );
    } else {
      // Créer un CartItem par produit du menu en transaction
      await this.prisma.$transaction(
        menu.products.map((menuProduct) => {
          const variant = menuProduct.product.variants[0];
          if (!variant) {
            throw new BadRequestException(
              `Le produit "${menuProduct.product.nom}" n'a pas de variante disponible.`,
            );
          }
          return this.prisma.cartItem.create({
            data: {
              cartId: cart.id,
              productId: menuProduct.productId,
              variantId: variant.id,
              menuId: dto.menuId,
              quantite: dto.quantite,
            },
          });
        }),
      );
    }

    return this.common.getCart(firebaseUid);
  }

  /**
   * Met à jour la quantité de tous les items d'un menu dans le panier.
   */
  async updateMenuQuantity(
    firebaseUid: string,
    menuId: string,
    dto: UpdateCartItemDto,
  ) {
    const user = await this.common.getUserOrThrow(firebaseUid);
    const cart = await this.common.getCartOrThrow(user.id);

    const menuItems = await this.prisma.cartItem.findMany({
      where: { cartId: cart.id, menuId },
    });

    if (menuItems.length === 0) {
      throw new NotFoundException("Ce menu n'est pas dans votre panier.");
    }

    if (dto.quantite === 0) {
      // Supprimer tout le groupe
      await this.prisma.cartItem.deleteMany({
        where: { cartId: cart.id, menuId },
      });
    } else {
      // Mettre à jour la quantité de tous les items
      await this.prisma.$transaction(
        menuItems.map((item) =>
          this.prisma.cartItem.update({
            where: { id: item.id },
            data: { quantite: dto.quantite },
          }),
        ),
      );
    }

    return this.common.getCart(firebaseUid);
  }

  /**
   * Supprime tous les items d'un menu du panier.
   */
  async removeMenu(firebaseUid: string, menuId: string) {
    const user = await this.common.getUserOrThrow(firebaseUid);
    const cart = await this.common.getCartOrThrow(user.id);

    const menuItems = await this.prisma.cartItem.findMany({
      where: { cartId: cart.id, menuId },
    });

    if (menuItems.length === 0) {
      throw new NotFoundException("Ce menu n'est pas dans votre panier.");
    }

    await this.prisma.cartItem.deleteMany({
      where: { cartId: cart.id, menuId },
    });

    return this.common.getCart(firebaseUid);
  }
}
