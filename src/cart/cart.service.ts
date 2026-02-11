import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { AddToCartDto } from './dto/add-to-cart.dto';
import { UpdateCartItemDto } from './dto/update-cart-item.dto';
import { AddMenuToCartDto } from './dto/add-menu-to-cart.dto';

@Injectable()
export class CartService {
  constructor(private prisma: PrismaService) {}

  /**
   * Récupère ou crée le panier d'un utilisateur.
   */
  private async getOrCreateCart(userId: string) {
    let cart = await this.prisma.cart.findUnique({
      where: { userId },
    });

    if (!cart) {
      cart = await this.prisma.cart.create({
        data: { userId },
      });
    }
    return cart;
  }

  /**
   * Ajoute un article individuel au panier ou met à jour sa quantité.
   * Vérifie que tous les articles du panier proviennent du même restaurant.
   */
  async addItem(firebaseUid: string, dto: AddToCartDto) {
    const user = await this.prisma.user.findUnique({ where: { firebaseUid } });
    if (!user) throw new NotFoundException('Utilisateur non trouvé.');

    const variant = await this.prisma.productVariant.findUnique({
      where: { id: dto.variantId },
      include: { product: true },
    });
    if (!variant)
      throw new NotFoundException('Variante de produit non trouvée.');

    const cart = await this.getOrCreateCart(user.id);

    const cartItems = await this.prisma.cartItem.findMany({
      where: { cartId: cart.id },
      include: { product: true },
    });

    // Vérifier si le panier n'est pas vide et si le nouvel article est d'un autre restaurant
    if (
      cartItems.length > 0 &&
      cartItems[0].product.restaurantId !== variant.product.restaurantId
    ) {
      throw new BadRequestException(
        'Vous ne pouvez commander que dans un seul restaurant à la fois. Veuillez vider votre panier pour continuer.',
      );
    }

    // Chercher un item individuel existant (menuId = null)
    const existingItem = await this.prisma.cartItem.findFirst({
      where: {
        cartId: cart.id,
        variantId: dto.variantId,
        menuId: null,
      },
    });

    if (existingItem) {
      // Mettre à jour la quantité si l'article existe déjà
      return this.prisma.cartItem.update({
        where: { id: existingItem.id },
        data: { quantite: existingItem.quantite + dto.quantite },
      });
    } else {
      // Créer un nouvel article dans le panier
      return this.prisma.cartItem.create({
        data: {
          cartId: cart.id,
          productId: variant.productId,
          variantId: dto.variantId,
          quantite: dto.quantite,
        },
      });
    }
  }

  /**
   * Ajoute un menu complet au panier comme unité atomique.
   * Tous les produits du menu sont ajoutés avec le menuId lié.
   */
  async addMenu(firebaseUid: string, dto: AddMenuToCartDto) {
    const user = await this.prisma.user.findUnique({ where: { firebaseUid } });
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

    const cart = await this.getOrCreateCart(user.id);

    // Vérifier la contrainte du même restaurant
    const cartItems = await this.prisma.cartItem.findMany({
      where: { cartId: cart.id },
      include: { product: true },
    });

    if (
      cartItems.length > 0 &&
      cartItems[0].product.restaurantId !== menu.restaurantId
    ) {
      throw new BadRequestException(
        'Vous ne pouvez commander que dans un seul restaurant à la fois. Veuillez vider votre panier pour continuer.',
      );
    }

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

    return this.getCart(firebaseUid);
  }

  /**
   * Met à jour la quantité de tous les items d'un menu dans le panier.
   */
  async updateMenuQuantity(
    firebaseUid: string,
    menuId: string,
    dto: UpdateCartItemDto,
  ) {
    const user = await this.prisma.user.findUnique({ where: { firebaseUid } });
    if (!user) throw new NotFoundException('Utilisateur non trouvé.');

    const cart = await this.prisma.cart.findUnique({
      where: { userId: user.id },
    });
    if (!cart) throw new NotFoundException('Panier non trouvé.');

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

    return this.getCart(firebaseUid);
  }

  /**
   * Supprime tous les items d'un menu du panier.
   */
  async removeMenu(firebaseUid: string, menuId: string) {
    const user = await this.prisma.user.findUnique({ where: { firebaseUid } });
    if (!user) throw new NotFoundException('Utilisateur non trouvé.');

    const cart = await this.prisma.cart.findUnique({
      where: { userId: user.id },
    });
    if (!cart) throw new NotFoundException('Panier non trouvé.');

    const menuItems = await this.prisma.cartItem.findMany({
      where: { cartId: cart.id, menuId },
    });

    if (menuItems.length === 0) {
      throw new NotFoundException("Ce menu n'est pas dans votre panier.");
    }

    await this.prisma.cartItem.deleteMany({
      where: { cartId: cart.id, menuId },
    });

    return this.getCart(firebaseUid);
  }

  /**
   * Récupère le contenu complet du panier de l'utilisateur.
   */
  async getCart(firebaseUid: string) {
    const user = await this.prisma.user.findUnique({ where: { firebaseUid } });
    if (!user) throw new NotFoundException('Utilisateur non trouvé.');

    return this.prisma.cart.findUnique({
      where: { userId: user.id },
      include: {
        items: {
          include: {
            product: {
              select: { nom: true, imageUrl: true, restaurantId: true },
            },
            variant: {
              select: { label: true, prix: true },
            },
            menu: {
              select: { id: true, nom: true, prix: true, imageUrl: true },
            },
          },
        },
      },
    });
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
    const user = await this.prisma.user.findUnique({ where: { firebaseUid } });
    if (!user) throw new NotFoundException('Utilisateur non trouvé.');

    const cartItem = await this.prisma.cartItem.findFirst({
      where: { id: cartItemId, cart: { userId: user.id } },
    });

    if (!cartItem) {
      throw new ForbiddenException("Cet article n'est pas dans votre panier.");
    }

    if (cartItem.menuId) {
      throw new BadRequestException(
        'Cet article fait partie d\'un menu. Utilisez la mise à jour du menu pour modifier la quantité.',
      );
    }

    return this.prisma.cartItem.update({
      where: { id: cartItemId },
      data: { quantite: dto.quantite },
    });
  }

  /**
   * Supprime un article individuel du panier.
   * Rejette si l'article fait partie d'un menu.
   */
  async removeItem(firebaseUid: string, cartItemId: string) {
    const user = await this.prisma.user.findUnique({ where: { firebaseUid } });
    if (!user) throw new NotFoundException('Utilisateur non trouvé.');

    const cartItem = await this.prisma.cartItem.findFirst({
      where: { id: cartItemId, cart: { userId: user.id } },
    });

    if (!cartItem) {
      throw new ForbiddenException("Cet article n'est pas dans votre panier.");
    }

    if (cartItem.menuId) {
      throw new BadRequestException(
        'Cet article fait partie d\'un menu. Utilisez la suppression du menu pour le retirer.',
      );
    }

    return this.prisma.cartItem.delete({
      where: { id: cartItemId },
    });
  }

  /**
   * Vide complètement le panier de l'utilisateur.
   */
  async clearCart(firebaseUid: string) {
    const user = await this.prisma.user.findUnique({ where: { firebaseUid } });
    if (!user) throw new NotFoundException('Utilisateur non trouvé.');

    const cart = await this.prisma.cart.findUnique({
      where: { userId: user.id },
    });
    if (!cart) return; // Le panier est déjà vide

    return this.prisma.cartItem.deleteMany({
      where: { cartId: cart.id },
    });
  }
}
