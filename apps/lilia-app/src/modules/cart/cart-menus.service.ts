/* eslint-disable prettier/prettier */
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { UpdateCartItemDto } from './dto/update-cart-item.dto';
import { AddMenuToCartDto } from './dto/add-menu-to-cart.dto';
import { CartCommonService } from './cart-common.service';
import { productStateReason } from '../products/product-availability';
import { lineStockUnits, stockShortage } from '../orders/stock-units';

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
            // F3-10 — le format servi est celui que le vendeur a désigné,
            // plus `variants[0]` d'une lecture non triée.
            product: true,
            variant: true,
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
    const cart = await this.common.getOrCreateCart(user.id);

    // Vérifier la contrainte du même restaurant
    const cartItems = await this.prisma.cartItem.findMany({
      where: { cartId: cart.id },
      include: { product: true, variant: { select: { stockConsumption: true } } },
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
    const existingMenuItems = cartItems.filter((i) => i.menuId === dto.menuId);
    this.assertMenuStock(
      menu,
      cartItems,
      (existingMenuItems[0]?.quantite ?? 0) + dto.quantite,
    );

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
        menu.products.map((menuProduct) =>
          this.prisma.cartItem.create({
            data: {
              cartId: cart.id,
              productId: menuProduct.productId,
              variantId: menuProduct.variantId,
              menuId: dto.menuId,
              quantite: dto.quantite,
            },
          }),
        ),
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

    // F3-10 — la quantité d'un menu n'était contrôlée nulle part avant le
    // checkout : on pouvait porter à 50 un menu dont il restait 2.
    const [menu, cartItems] = await Promise.all([
      this.prisma.menuDuJour.findUnique({
        where: { id: menuId },
        include: { products: { include: { product: true, variant: true } } },
      }),
      this.prisma.cartItem.findMany({
        where: { cartId: cart.id },
        include: { variant: { select: { stockConsumption: true } } },
      }),
    ]);
    if (menu) this.assertMenuStock(menu, cartItems, dto.quantite);

    // `UpdateCartItemDto` impose `@Min(1)` : la branche « quantite === 0 =
    // suppression du groupe » était inatteignable depuis HTTP (fix L1). Pour
    // retirer un menu, le client appelle DELETE /cart/menus/:menuId.
    await this.prisma.$transaction(
      menuItems.map((item) =>
        this.prisma.cartItem.update({
          where: { id: item.id },
          data: { quantite: dto.quantite },
        }),
      ),
    );

    return this.common.getCart(firebaseUid);
  }

  /**
   * F3-10 — le menu et chacun de ses composants tiennent-ils dans le stock ?
   *
   * `POST /cart/menus` ne contrôlait **aucun** stock : ni celui du menu, ni
   * celui des produits qui le composent. Le refus n'arrivait qu'au checkout.
   * Un composant consomme `quantiteMenu × stockConsumption` de SON format
   * (« Carton découverte » = 6 bouteilles par menu), en plus des autres lignes
   * du même produit déjà au panier.
   */
  private assertMenuStock(
    menu: {
      id: string;
      nom: string;
      stockRestant: number | null;
      products: {
        productId: string;
        product: {
          id: string;
          nom: string;
          stockRestant: number | null;
          isAvailable: boolean;
          deletedAt: Date | null;
          availableFrom: string | null;
          availableUntil: string | null;
        };
        variant: { id: string; label: string | null; stockConsumption: number };
      }[];
    },
    cartItems: {
      productId: string;
      menuId: string | null;
      quantite: number;
      variant: { stockConsumption: number } | null;
    }[],
    menuQuantity: number,
  ): void {
    if (menu.stockRestant !== null && menu.stockRestant < menuQuantity) {
      throw new BadRequestException({
        message:
          menu.stockRestant === 0
            ? `Menu « ${menu.nom} » épuisé.`
            : `Menu « ${menu.nom} » : il n'en reste que ${menu.stockRestant}.`,
        code: 'OUT_OF_STOCK',
        menuId: menu.id,
        availableQuantity: menu.stockRestant,
      });
    }
    const now = new Date();
    for (const component of menu.products) {
      const reason = productStateReason(component.product, now);
      if (reason) throw new BadRequestException(reason);
      const otherUnits = cartItems
        .filter((i) => i.productId === component.productId && i.menuId !== menu.id)
        .reduce((sum, i) => sum + lineStockUnits(i), 0);
      const shortage = stockShortage({
        product: component.product,
        variant: component.variant,
        quantite: menuQuantity,
        otherUnits,
      });
      if (shortage) throw shortage;
    }
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
