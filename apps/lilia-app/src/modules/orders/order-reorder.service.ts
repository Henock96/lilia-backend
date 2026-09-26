import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PlatformSettingsService } from '../platform-settings/platform-settings.service';
import {
  PRODUCT_MODIFIER_GROUPS_ARGS,
  toModifierContext,
} from '../modifiers/modifier-catalog';
import {
  ModifierSelectionError,
  resolveSelection,
} from '../modifiers/modifier-selection';
import { mergeCartLine } from '../modifiers/cart-line-merge';
import { productStateReason } from '../products/product-availability';
import { CartService } from '../cart/cart.service';
import { countMenus } from './menu-quantities';
import { lineStockUnits, stockShortage } from './stock-units';

/** Format retrouvé par son libellé figé — seulement s'il est unique. */
function uniqueByLabel<V extends { label: string | null }>(
  variants: readonly V[],
  label: string | null | undefined,
): V | undefined {
  const key = (label ?? '').trim().toLowerCase();
  const matches = variants.filter(
    (v) => (v.label ?? '').trim().toLowerCase() === key,
  );
  return matches.length === 1 ? matches[0] : undefined;
}

function httpBody(error: unknown): Record<string, unknown> | undefined {
  if (error instanceof HttpException) {
    const body = error.getResponse();
    return typeof body === 'object'
      ? (body as Record<string, unknown>)
      : { message: body };
  }
  return undefined;
}
function httpMessage(error: unknown, fallback: string): string {
  const message = httpBody(error)?.message;
  return typeof message === 'string' ? message : fallback;
}
function httpCode(error: unknown): string | undefined {
  const code = httpBody(error)?.code;
  return typeof code === 'string' ? code : undefined;
}
function httpAvailable(error: unknown): number | undefined {
  const n = httpBody(error)?.availableQuantity;
  return typeof n === 'number' ? n : undefined;
}

/**
 * Recommande (reorder) une commande précédente (LIL-134).
 *
 * Recopie les items d'une commande passée dans le panier courant, en gérant la
 * résolution de variante, le conflit multi-restaurant et l'indisponibilité des
 * produits. Extrait de `OrderLifecycleService` pour le ramener sous ~400 LOC.
 */
@Injectable()
export class OrderReorderService {
  private readonly logger = new Logger(OrderReorderService.name);

  constructor(
    private readonly prisma: PrismaService,
    // F3-09 — l'interrupteur des options décide de la résolution.
    private readonly platformSettings: PlatformSettingsService,
    // F3-10 — un menu se rachète par le même chemin que `POST /cart/menus`.
    private readonly cartService: CartService,
  ) {}

  async reorderFromPreviousOrder(orderId: string, firebaseUid: string) {
    // 1. Vérifier l'utilisateur
    const user = await this.prisma.user.findUnique({
      where: { firebaseUid },
      include: { cart: true },
    });

    if (!user) {
      throw new NotFoundException('Utilisateur non trouvé.');
    }

    // 2. Récupérer la commande avec ses items
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: {
        items: {
          include: {
            product: {
              include: {
                variants: true,
                modifierGroups: PRODUCT_MODIFIER_GROUPS_ARGS,
              },
            },
            menu: { select: { nom: true } },
            // Options figées de la commande : ce que le client avait choisi.
            options: {
              orderBy: { position: 'asc' },
              select: { optionId: true, optionName: true, quantity: true },
            },
          },
        },
        restaurant: {
          select: {
            id: true,
            nom: true,
          },
        },
      },
    });

    if (!order) {
      throw new NotFoundException('Commande non trouvée.');
    }

    // 3. Vérifier que l'utilisateur est le propriétaire de la commande
    if (order.userId !== user.id) {
      throw new ForbiddenException('Cette commande ne vous appartient pas.');
    }

    // 4. Vérifier le panier actuel
    let cart = user.cart;
    if (!cart) {
      cart = await this.prisma.cart.create({
        data: { userId: user.id },
      });
    }

    // Récupérer les items actuels du panier
    const currentCartItems = await this.prisma.cartItem.findMany({
      where: { cartId: cart.id },
      include: { product: true },
    });

    // Vérifier si le panier contient des items d'un autre restaurant
    if (currentCartItems.length > 0) {
      const currentRestaurantId = currentCartItems[0].product.restaurantId;

      if (currentRestaurantId !== order.restaurantId) {
        throw new BadRequestException(
          `Votre panier contient déjà des articles d'un autre restaurant. Veuillez le vider pour commander de ${order.restaurant.nom}.`,
        );
      }
    }

    const { modifiersEnabled } = await this.platformSettings.getSettings();

    // 5. Ajouter les items de la commande au panier
    const results: {
      added: Record<string, unknown>[];
      unavailable: Record<string, unknown>[];
      errors: Record<string, unknown>[];
    } = {
      added: [],
      unavailable: [],
      errors: [],
    };

    this.logger.log(
      `🔄 [REORDER] Commande ${orderId}: ${order.items.length} items à ajouter au panier`,
    );

    // F3-10 — les lignes de menu se rachètent comme **menu** (même chemin et
    // mêmes contrôles que `POST /cart/menus`), plus comme articles isolés au
    // prix de la variante : l'ancien reorder recréait trois plats à la carte
    // à la place d'un menu.
    const menus = countMenus(order.items);
    for (const [menuId, quantite] of menus) {
      const menuName =
        order.items.find((item) => item.menuId === menuId)?.menu?.nom ?? 'Menu';
      try {
        await this.cartService.addMenu(firebaseUid, { menuId, quantite });
        results.added.push({
          productName: menuName,
          menuId,
          quantity: quantite,
        });
      } catch (error) {
        results.unavailable.push({
          productName: menuName,
          menuId,
          reason: httpMessage(error, 'Ce menu n’est plus proposé.'),
          code: httpCode(error) ?? 'MENU_UNAVAILABLE',
          ...(httpAvailable(error) !== undefined
            ? { availableQuantity: httpAvailable(error) }
            : {}),
        });
      }
    }

    for (const orderItem of order.items) {
      if (orderItem.menuId) continue;
      try {
        const product = orderItem.product;
        if (!product) {
          results.unavailable.push({
            productId: orderItem.productId,
            reason: 'Produit introuvable',
            code: 'VARIANT_UNAVAILABLE',
          });
          continue;
        }

        // F3-10 / D12 — le format **exact** acheté, par son identifiant. Une
        // commande antérieure au 04/04/2026 n'en a pas : son libellé figé, à
        // condition qu'il désigne un seul format. **Jamais `variants[0]`** :
        // l'ancien repli ajoutait en silence un autre format, à un autre prix
        // (et, depuis F3-10, avec une autre consommation de stock).
        //
        // La conversion ne peut pas avoir changé depuis la commande : elle est
        // immuable. « Carton de 12 » qui remplace « Carton de 6 » est un autre
        // format, donc un autre identifiant — il n'est pas retrouvé ici.
        const variant = orderItem.variantId
          ? product.variants.find((v) => v.id === orderItem.variantId)
          : uniqueByLabel(product.variants, orderItem.variant);

        if (!variant) {
          this.logger.warn(
            `[REORDER] format introuvable produit=${product.id} variantId=${orderItem.variantId ?? '∅'} libellé="${orderItem.variant}"`,
          );
          results.unavailable.push({
            productName: product.nom,
            variant: orderItem.variantLabel ?? orderItem.variant,
            reason: `Le format « ${orderItem.variantLabel ?? orderItem.variant} » n'est plus proposé.`,
            code: 'VARIANT_UNAVAILABLE',
          });
          continue;
        }

        const state = productStateReason(product, new Date());
        if (state) {
          results.unavailable.push({
            productName: product.nom,
            reason: state,
            code: 'PRODUCT_UNAVAILABLE',
          });
          continue;
        }

        // F3-09 — une option supprimée du catalogue a laissé une copie figée
        // sans lien (`optionId = null`) : on ne la remplace jamais par une
        // autre. La ligne est signalée, pas recomposée.
        const gone = orderItem.options.find(
          (option) => option.optionId === null,
        );
        if (gone) {
          results.unavailable.push({
            productName: product.nom,
            reason: `L'option « ${gone.optionName} » n'est plus proposée.`,
          });
          continue;
        }
        let selection;
        try {
          selection = resolveSelection({
            basePriceXaf: variant.prix,
            product: toModifierContext(product),
            selection: orderItem.options.map((option) => ({
              optionId: option.optionId!,
              quantity: option.quantity,
            })),
            modifiersEnabled,
          });
        } catch (err) {
          if (!(err instanceof ModifierSelectionError)) throw err;
          results.unavailable.push({
            productName: product.nom,
            reason: err.message,
            code: err.code,
          });
          continue;
        }

        // F3-10 — stock, contre le panier **tel qu'il est maintenant** (lignes
        // déjà présentes et celles que ce reorder vient d'ajouter). Quantité
        // insuffisante : la ligne est ignorée et signalée avec ce qu'il reste,
        // jamais réduite en silence.
        const inCart = await this.prisma.cartItem.findMany({
          where: { cartId: cart.id, productId: product.id },
          select: {
            productId: true,
            quantite: true,
            variant: { select: { stockConsumption: true } },
          },
        });
        const shortage = stockShortage({
          product,
          variant,
          quantite: orderItem.quantite,
          otherUnits: inCart.reduce(
            (sum, line) => sum + lineStockUnits(line),
            0,
          ),
        });
        if (shortage) {
          const body = shortage.getResponse() as {
            message: string;
            availableQuantity: number;
          };
          results.unavailable.push({
            productName: product.nom,
            variant: variant.label,
            reason: body.message,
            code: 'OUT_OF_STOCK',
            availableQuantity: body.availableQuantity,
          });
          continue;
        }

        // Même écriture que `POST /cart/add` : fusion atomique par
        // `(variante, signature)` — l'ancienne forme lisait la quantité puis
        // la réécrivait, et perdait un ajout concurrent.
        await mergeCartLine(this.prisma, {
          cartId: cart.id,
          productId: product.id,
          variantId: variant.id,
          selection,
          quantite: orderItem.quantite,
        });

        results.added.push({
          productName: product.nom,
          variant: variant.label,
          quantity: orderItem.quantite,
          options: selection.lines.map((option) => option.optionName),
        });
      } catch (error) {
        this.logger.error(
          `Error adding item ${orderItem.productId} to cart:`,
          error,
        );
        results.errors.push({
          productId: orderItem.productId,
          //error: error.message,
        });
      }
    }

    // 6. Récupérer le panier mis à jour
    const updatedCart = await this.prisma.cart.findUnique({
      where: { id: cart.id },
      include: {
        items: {
          include: {
            product: {
              select: {
                nom: true,
                imageUrl: true,
                restaurantId: true,
              },
            },
            variant: {
              select: {
                label: true,
                prix: true,
              },
            },
            options: { select: { optionId: true, quantity: true } },
          },
        },
      },
    });

    return {
      message: 'Commande ajoutée au panier avec succès',
      cart: updatedCart,
      summary: {
        totalAdded: results.added.length,
        totalUnavailable: results.unavailable.length,
        totalErrors: results.errors.length,
      },
      details: results,
    };
  }
}
