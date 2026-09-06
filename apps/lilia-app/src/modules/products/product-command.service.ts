/* eslint-disable prettier/prettier */
import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { AdminAuditAction, ProductType } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { ProductValidatorService } from './product-validator.service';
import { RestaurantAccessService } from '../restaurants/restaurant-access.service';
import { AdminAuditService } from '../admin-audit/admin-audit.service';

/**
 * Écritures du catalogue produits (extrait de ProductsService — LIL-143).
 * Regroupe le CRUD (create/update/remove) et la gestion du stock.
 * La validation multi-vendeurs reste déléguée à ProductValidatorService.
 */
@Injectable()
export class ProductCommandService {
  constructor(
    private prisma: PrismaService,
    private readonly productValidator: ProductValidatorService,
    private readonly access: RestaurantAccessService,
    private readonly audit: AdminAuditService,
  ) {}

  async create(dto: CreateProductDto, firebaseUid: string) {
    // `dto.restaurantId` n'est renseigné que par un administrateur agissant au
    // nom d'un vendeur (amorçage de catalogue, dépannage). Le vendeur, lui, ne
    // le transmet pas et reste cantonné à sa propre boutique.
    const restaurant = await this.access.resolveTargetRestaurant(
      firebaseUid,
      dto.restaurantId,
    );

    await this.assertCategoryBelongsTo(restaurant.id, dto.categoryId);

    // Multi-vendeurs : valider que le vendorType accepte ce productType.
    // FOOD est le défaut historique et reste compatible avec RESTAURANT.
    const productType = dto.productType ?? ProductType.FOOD;
    this.productValidator.assertProductTypeAllowed(
      restaurant.vendorType,
      productType,
    );
    this.productValidator.assertAvailabilityWindow(
      dto.availableFrom,
      dto.availableUntil,
    );

    const produit = await this.prisma.$transaction(async (tx) => {
      // 1. Créer le produit de base
      const product = await tx.product.create({
        data: {
          nom: dto.nom,
          description: dto.description,
          imageUrl: dto.imageUrl,
          prixOriginal: dto.prixOriginal,
          restaurantId: restaurant.id,
          categoryId: dto.categoryId,
          productType,
          stockMode: dto.stockMode,
          stockQuotidien: dto.stockQuotidien,
          stockRestant: dto.stockQuotidien,
          ingredients: dto.ingredients,
          shelfLifeDays: dto.shelfLifeDays,
          madeToOrder: dto.madeToOrder ?? false,
          availableFrom: dto.availableFrom,
          availableUntil: dto.availableUntil,
        },
      });

      // 2. Gérer les variantes
      const variantsToCreate =
        dto.variants && dto.variants.length > 0
          ? dto.variants.map((v) => ({ ...v, productId: product.id }))
          : [
              {
                label: 'Standard',
                prix: dto.prixOriginal,
                productId: product.id,
              },
            ];

      await tx.productVariant.createMany({
        data: variantsToCreate,
      });

      // 3. Retourner le produit complet avec ses variantes
      return tx.product.findUnique({
        where: { id: product.id },
        include: {
          variants: true,
        },
      });
    });

    // Écriture d'un administrateur dans le catalogue d'un tiers : le geste est
    // légitime mais doit rester opposable — c'est le prix de la permission
    // qu'on vient d'ouvrir.
    if (restaurant.onBehalfOf) {
      await this.recordAdminCatalogEdit(firebaseUid, restaurant.id, {
        entity: 'Product',
        productId: produit?.id,
        nom: dto.nom,
      });
    }

    return {
      message: 'Création de produit réussie',
      data: produit,
    }
  }

  /**
   * Une catégorie ne s'utilise que chez son propre vendeur.
   *
   * La clé étrangère **composite** `(categoryId, restaurantId)` porte déjà cette
   * règle en base : une écriture qui passerait outre serait refusée par
   * PostgreSQL, y compris hors Prisma. Ce contrôle applicatif existe pour rendre
   * un message utile — un P2003 brut ne dit pas au vendeur *ce qu'il doit
   * corriger* — et non pour tenir la garantie, qui n'a pas à dépendre d'un `if`.
   */
  private async assertCategoryBelongsTo(
    restaurantId: string,
    categoryId?: string | null,
  ): Promise<void> {
    if (!categoryId) return;

    const category = await this.prisma.category.findUnique({
      where: { id: categoryId },
      select: { restaurantId: true },
    });
    if (!category) {
      throw new NotFoundException("La catégorie spécifiée n'existe pas.");
    }
    if (category.restaurantId !== restaurantId) {
      throw new BadRequestException(
        "Cette catégorie appartient à un autre vendeur. Choisissez une de vos propres sections de menu.",
      );
    }
  }

  /** Trace une écriture faite par un ADMIN au nom d'un vendeur. */
  private async recordAdminCatalogEdit(
    firebaseUid: string,
    restaurantId: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    const actor = await this.prisma.user.findUnique({
      where: { firebaseUid },
      select: { id: true },
    });
    if (!actor) return;
    await this.audit.record({
      actorId: actor.id,
      action: AdminAuditAction.VENDOR_CATALOG_EDITED,
      targetType: 'Restaurant',
      targetId: restaurantId,
      metadata: metadata as never,
    });
  }

  /**
   * Met à jour un produit
   */
  async update(id: string, dto: UpdateProductDto, firebaseUid: string) {
    // Vérifier que le produit existe et appartient au restaurant de l'utilisateur
    const product = await this.prisma.product.findUnique({
      where: { id },
      include: {
        restaurant: {
          include: { owner: true },
        },
      },
    });

    if (!product) {
      throw new NotFoundException(`Produit avec l'ID "${id}" non trouvé.`);
    }

    const actorUpdate = await this.prisma.user.findUnique({ where: { firebaseUid } });
    if (actorUpdate?.role !== 'ADMIN' && product.restaurant.owner.firebaseUid !== firebaseUid) {
      throw new ForbiddenException('Vous n\'êtes pas autorisé à modifier ce produit.');
    }

    // La catégorie doit appartenir au vendeur DU PRODUIT — pas à celui de
    // l'appelant, qui peut être un ADMIN agissant pour un tiers.
    await this.assertCategoryBelongsTo(product.restaurantId, dto.categoryId);

    // Multi-vendeurs : si changement de productType, revalider la compat.
    if (dto.productType && dto.productType !== product.productType) {
      this.productValidator.assertProductTypeAllowed(
        product.restaurant.vendorType,
        dto.productType,
      );
    }
    // Si une seule borne horaire est touchée, valider la fenêtre finale.
    if (dto.availableFrom !== undefined || dto.availableUntil !== undefined) {
      this.productValidator.assertAvailabilityWindow(
        dto.availableFrom ?? product.availableFrom ?? undefined,
        dto.availableUntil ?? product.availableUntil ?? undefined,
      );
    }

    const { variants, ...productData } = dto;

    // ─── Stock : `stockQuotidien` seul ne suffit pas (fix S-1) ────────────────
    //
    // `stockRestant` est ce qui décide de la vente ; `stockQuotidien` n'est que
    // la capacité déclarée. Écrire l'une sans l'autre laissait un produit
    // épuisé (`stockRestant = 0`) invendable après un réassort — définitivement
    // pour un `stockMode = PERMANENT`, que le cron de 5 h ne touche jamais.
    //
    // On ne réaligne QUE si la capacité déclarée change réellement. Les deux
    // formulaires produit renvoient le champ à chaque enregistrement : sans
    // cette garde, corriger une faute de frappe dans une description à 15 h
    // ressusciterait le stock déjà vendu dans la journée.
    //
    // Le geste « j'ai réassorti sans changer ma capacité » a sa propre route,
    // `PATCH /products/:id/stock` → `updateStock()`, qui réaligne
    // inconditionnellement. Deux intentions différentes, deux points d'entrée.
    const stockData: { stockRestant?: number | null } = {};
    if (
      dto.stockQuotidien !== undefined &&
      dto.stockQuotidien !== product.stockQuotidien
    ) {
      // `null` = illimité, et se propage tel quel.
      stockData.stockRestant = dto.stockQuotidien;
    }

    const updatedProduct = await this.prisma.$transaction(async (tx) => {
      // 1. Mettre à jour le produit
      const updated = await tx.product.update({
        where: { id },
        data: { ...productData, ...stockData },
      });

      // 2. Gérer les variantes si fournies
      if (variants !== undefined) {
        // Récupérer les IDs des anciennes variantes
        const oldVariants = await tx.productVariant.findMany({
          where: { productId: id },
          select: { id: true },
        });
        const oldVariantIds = oldVariants.map((v) => v.id);

        // Supprimer d'abord les CartItems qui référencent ces variantes
        if (oldVariantIds.length > 0) {
          await tx.cartItem.deleteMany({
            where: { variantId: { in: oldVariantIds } },
          });
        }

        // Supprimer les anciennes variantes
        await tx.productVariant.deleteMany({
          where: { productId: id },
        });

        // Créer les nouvelles variantes
        if (variants.length > 0) {
          await tx.productVariant.createMany({
            data: variants.map((v) => ({
              label: v.label,
              prix: v.prix,
              productId: id,
            })),
          });
        } else {
          // Si aucune variante fournie, créer une variante par défaut
          await tx.productVariant.create({
            data: {
              label: 'Standard',
              prix: updated.prixOriginal,
              productId: id,
            },
          });
        }
      }

      // 3. Retourner le produit complet avec ses variantes
      return tx.product.findUnique({
        where: { id },
        include: {
          category: true,
          variants: true,
        },
      });
    });

    return {
      message: 'Produit mis à jour avec succès',
      data: updatedProduct,
    };
  }

  /**
   * Retire un produit du catalogue.
   *
   * Fix M2 (audit du 28/08/2026) : la méthode faisait un `DELETE` réel. Depuis
   * l'activation des clés étrangères (Ar1), `OrderItem.productId` est en
   * RESTRICT — donc dès la **première vente**, la suppression renvoyait un 409
   * et le vendeur n'avait plus aucun moyen de retirer son produit ; le seul
   * contournement (`stockQuotidien = 0`) l'affiche « épuisé », ce qui n'est pas
   * la même information pour le client.
   *
   * On fait donc un **soft delete** dès que le produit a un historique : la
   * ligne survit pour que les commandes passées restent lisibles, mais elle
   * disparaît du catalogue. Un produit jamais commandé est réellement supprimé
   * (rien à préserver).
   */
  async remove(id: string, firebaseUid: string) {
    // Vérifier que le produit existe et appartient au restaurant de l'utilisateur
    const product = await this.prisma.product.findUnique({
      where: { id },
      include: {
        restaurant: {
          include: { owner: true },
        },
      },
    });

    if (!product) {
      throw new NotFoundException(`Produit avec l'ID "${id}" non trouvé.`);
    }

    const actorRemove = await this.prisma.user.findUnique({ where: { firebaseUid } });
    if (actorRemove?.role !== 'ADMIN' && product.restaurant.owner.firebaseUid !== firebaseUid) {
      throw new ForbiddenException('Vous n\'êtes pas autorisé à supprimer ce produit.');
    }

    const soldAtLeastOnce = await this.prisma.orderItem.count({
      where: { productId: id },
    });

    await this.prisma.$transaction(async (tx) => {
      // Les paniers en cours référencent des variantes qui vont disparaître du
      // catalogue : on les vide dans les deux cas. (Le client n'en est pas
      // averti — ce point reste une amélioration UX à traiter côté apps.)
      const variants = await tx.productVariant.findMany({
        where: { productId: id },
        select: { id: true },
      });
      const variantIds = variants.map((v) => v.id);

      if (variantIds.length > 0) {
        await tx.cartItem.deleteMany({
          where: { variantId: { in: variantIds } },
        });
      }

      if (soldAtLeastOnce > 0) {
        // Soft delete : la ligne reste, pointée par des OrderItem en RESTRICT.
        await tx.product.update({
          where: { id },
          data: { deletedAt: new Date(), isAvailable: false },
        });
        // Le produit ne doit plus composer de menu du jour.
        await tx.menuProduct.deleteMany({ where: { productId: id } });
        return;
      }

      // Jamais vendu : suppression réelle, rien à conserver.
      await tx.productVariant.deleteMany({ where: { productId: id } });
      await tx.menuProduct.deleteMany({ where: { productId: id } });
      await tx.product.delete({ where: { id } });
    });

    return {
      message:
        soldAtLeastOnce > 0
          ? 'Produit retiré du catalogue (historique des commandes conservé)'
          : 'Produit supprimé avec succès',
    };
  }

  /**
   * Active / désactive la vente d'un produit (fix M2).
   *
   * `stockQuotidien = 0` affiche « épuisé » — ce n'est pas la même information
   * qu'« indisponible », et c'était pourtant le seul levier dont disposait le
   * vendeur pour retirer temporairement un produit.
   */
  async setAvailability(
    productId: string,
    isAvailable: boolean,
    firebaseUid: string,
  ) {
    const product = await this.prisma.product.findUnique({
      where: { id: productId },
      include: { restaurant: { include: { owner: true } } },
    });
    if (!product) {
      throw new NotFoundException(`Produit avec l'ID "${productId}" non trouvé.`);
    }
    if (product.deletedAt) {
      throw new BadRequestException('Ce produit a été retiré du catalogue.');
    }

    const user = await this.prisma.user.findUnique({ where: { firebaseUid } });
    if (!user) throw new NotFoundException('Utilisateur non trouvé.');
    if (
      user.role !== 'ADMIN' &&
      product.restaurant.owner.firebaseUid !== firebaseUid
    ) {
      throw new ForbiddenException(
        "Vous n'êtes pas autorisé à modifier ce produit.",
      );
    }

    const updated = await this.prisma.product.update({
      where: { id: productId },
      data: { isAvailable },
    });

    return {
      message: isAvailable
        ? 'Produit remis en vente'
        : 'Produit marqué indisponible',
      data: updated,
    };
  }

  /**
   * Met à jour le stock d'un produit
   */
  async updateStock(productId: string, stockQuotidien: number | null, firebaseUid: string) {
    const product = await this.prisma.product.findUnique({
      where: { id: productId },
      include: { restaurant: { include: { owner: true } } },
    });

    if (!product) {
      throw new NotFoundException(`Produit avec l'ID "${productId}" non trouvé.`);
    }

    const user = await this.prisma.user.findUnique({ where: { firebaseUid } });
    if (!user) throw new NotFoundException('Utilisateur non trouvé.');

    if (user.role !== 'ADMIN' && product.restaurant.owner.firebaseUid !== firebaseUid) {
      throw new ForbiddenException('Vous n\'êtes pas autorisé à modifier le stock de ce produit.');
    }

    const updated = await this.prisma.product.update({
      where: { id: productId },
      data: {
        stockQuotidien: stockQuotidien,
        stockRestant: stockQuotidien,
      },
    });

    return {
      message: 'Stock mis à jour avec succès',
      data: updated,
    };
  }
}
