import {
  BadRequestException,
  ForbiddenException,
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
    const results = {
      added: [],
      unavailable: [],
      errors: [],
    };

    this.logger.log(
      `🔄 [REORDER] Commande ${orderId}: ${order.items.length} items à ajouter au panier`,
    );

    for (const orderItem of order.items) {
      try {
        // Vérifier que le produit existe toujours
        const product = orderItem.product;
        this.logger.log(
          `🔄 [REORDER] Item: productId=${orderItem.productId}, variant="${orderItem.variant}", product exists=${!!product}, variants count=${product?.variants?.length ?? 0}`,
        );
        if (!product) {
          results.unavailable.push({
            productId: orderItem.productId,
            reason: 'Produit introuvable',
          });
          continue;
        }

        // Trouver la variante correspondante
        // 1. Chercher par label exact
        let variant = product.variants.find(
          (v) => v.label === orderItem.variant,
        );

        // 2. Chercher par label case-insensitive / trimmed
        if (!variant) {
          const orderVariantLower = (orderItem.variant || '')
            .trim()
            .toLowerCase();
          variant = product.variants.find(
            (v) => (v.label || '').trim().toLowerCase() === orderVariantLower,
          );
        }

        // 3. Si la variante n'existe plus, prendre la première disponible
        if (!variant && product.variants.length > 0) {
          variant = product.variants[0];
          this.logger.warn(
            `Variant "${orderItem.variant}" not found for product ${product.id}, using default variant "${variant.label}"`,
          );
        }

        if (!variant) {
          results.unavailable.push({
            productName: product.nom,
            reason: 'Aucune variante disponible',
          });
          continue;
        }

        // F3-09 — la sélection d'options d'origine, résolue par LE moteur
        // contre la carte d'aujourd'hui (décision Q7). Une option disparue,
        // en rupture, ou un groupe devenu obligatoire : la ligne est IGNORÉE
        // et signalée. Jamais « Poulet + Alloco » recréé en « Poulet » seul —
        // ce serait un autre plat, à un autre prix, que le client n'a pas
        // demandé.
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
