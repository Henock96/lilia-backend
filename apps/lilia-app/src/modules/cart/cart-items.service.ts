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
import { productStateReason } from '../products/product-availability';
import { lineStockUnits, stockShortage } from '../orders/stock-units';
import { PlatformSettingsService } from '../platform-settings/platform-settings.service';
import {
  PRODUCT_MODIFIER_GROUPS_ARGS,
  toModifierContext,
} from '../modifiers/modifier-catalog';
import {
  ModifierSelectionError,
  resolveSelection,
  type ResolvedSelection,
} from '../modifiers/modifier-selection';
import { modifierErrorForCart } from '../modifiers/modifier-http';
import { mergeCartLine } from '../modifiers/cart-line-merge';

/**
 * Opérations panier sur les articles individuels (extrait de CartService —
 * LIL-147) : ajout, mise à jour de quantité, suppression.
 */
@Injectable()
export class CartItemsService {
  constructor(
    private prisma: PrismaService,
    private readonly common: CartCommonService,
    private readonly platformSettings: PlatformSettingsService,
  ) {}

  /**
   * Ajoute un article individuel au panier ou met à jour sa quantité.
   * Vérifie que tous les articles du panier proviennent du même restaurant.
   */
  async addItem(firebaseUid: string, dto: AddToCartDto) {
    const user = await this.common.getUserOrThrow(firebaseUid);
    const [variant, settings] = await Promise.all([
      this.prisma.productVariant.findUnique({
        where: { id: dto.variantId },
        include: {
          product: {
            include: { modifierGroups: PRODUCT_MODIFIER_GROUPS_ARGS },
          },
        },
      }),
      this.platformSettings.getSettings(),
    ]);
    if (!variant)
      throw new NotFoundException('Variante de produit non trouvée.');

    // F3-09 — options résolues par LE moteur, contre le catalogue courant.
    // Refus nominatif et tôt : une application ancienne (sans `options`) sur
    // un produit à groupe obligatoire reçoit `400 MODIFIER_REQUIRED` — on ne
    // choisit jamais l'accompagnement à la place du client.
    let selection: ResolvedSelection;
    try {
      selection = resolveSelection({
        basePriceXaf: variant.prix,
        product: toModifierContext(variant.product),
        selection: dto.options ?? [],
        modifiersEnabled: settings.modifiersEnabled,
      });
    } catch (err) {
      if (err instanceof ModifierSelectionError) throw modifierErrorForCart(err);
      throw err;
    }

    const cart = await this.common.getOrCreateCart(user.id);

    const cartItems = await this.prisma.cartItem.findMany({
      where: { cartId: cart.id },
      include: { product: true, variant: { select: { stockConsumption: true } } },
    });

    this.common.assertSameRestaurant(cartItems, variant.product.restaurantId);
    this.common.assertSameMadeToOrderMode(cartItems, variant.product.madeToOrder);

    // Fixes M1 + M2 + S-2 : produit retiré du catalogue, marqué indisponible,
    // hors de sa fenêtre horaire, ou stock insuffisant — refusé ici plutôt
    // qu'au checkout.
    //
    // ⚠️ La quantité contrôlée est le **total du panier après ajout**, pas
    // celle de la requête. Ajouter 1 unité dix fois de suite est le geste
    // ordinaire d'un client sur mobile : ne valider que l'incrément laisserait
    // passer n'importe quel total, un ajout à la fois.
    //
    // Et elle couvre **toutes les lignes du même produit**, formats et
    // composants de menu compris : c'est le produit qui porte le stock.
    //
    // F3-10 : en **unités de stock** — une ligne pèse `quantite ×
    // stockConsumption` (1 carton de 6 = 6 bouteilles). Le refus est codé
    // `OUT_OF_STOCK` et dit ce qu'il reste de CE format.
    const reason = productStateReason(variant.product, new Date());
    if (reason) throw new BadRequestException(reason);

    const alreadyInCart = cartItems
      .filter((item) => item.productId === variant.productId)
      .reduce((sum, item) => sum + lineStockUnits(item), 0);
    const shortage = stockShortage({
      product: variant.product,
      variant,
      quantite: dto.quantite,
      otherUnits: alreadyInCart,
    });
    if (shortage) throw shortage;

    await mergeCartLine(this.prisma, {
      cartId: cart.id,
      productId: variant.productId,
      variantId: dto.variantId,
      selection,
      quantite: dto.quantite,
    });

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
      include: { product: true, variant: true },
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
      select: {
        productId: true,
        quantite: true,
        variant: { select: { stockConsumption: true } },
      },
    });

    const reason = productStateReason(cartItem.product, new Date());
    if (reason) throw new BadRequestException(reason);
    const shortage = stockShortage({
      product: cartItem.product,
      variant: cartItem.variant,
      quantite: dto.quantite,
      otherUnits: siblings.reduce((sum, s) => sum + lineStockUnits(s), 0),
      cartItemId,
    });
    if (shortage) throw shortage;

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
