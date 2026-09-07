/* eslint-disable prettier/prettier */
import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { AdminAuditAction, Prisma, ProductType } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { ReorderProductsDto } from './dto/reorder-products.dto';
import { ProductValidatorService } from './product-validator.service';
import { MENU_PRODUCTS_ORDER_BY } from './vendor-menu.include';
import {
  CATALOG_CHANGED,
  CatalogChangedEvent,
} from '../events/catalog-events';
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
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /**
   * Signale que la carte de ce vendeur a changé.
   *
   * Émis **après** la transaction, jamais dedans : l'invalidation du cache du
   * site est du « au mieux », elle ne doit ni retarder ni faire échouer une
   * écriture. Voir `CatalogRevalidationService`.
   */
  private touchCatalog(restaurantId: string, reason: string): void {
    this.eventEmitter.emit(
      CATALOG_CHANGED,
      new CatalogChangedEvent(restaurantId, reason),
    );
  }

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

    this.touchCatalog(restaurant.id, 'product.created');

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

      // 2. Réconcilier les variantes si fournies
      if (variants !== undefined) {
        await this.reconcileVariants(tx, id, variants, updated.prixOriginal);
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

    this.touchCatalog(product.restaurantId, 'product.updated');

    return {
      message: 'Produit mis à jour avec succès',
      data: updatedProduct,
    };
  }

  /**
   * Aligne les variantes d'un produit sur celles soumises — **sans détruire ce
   * qui n'a pas changé**.
   *
   * ## Le défaut corrigé (audit du 06/09/2026)
   *
   * La version précédente faisait un « détruire puis recréer » :
   *
   * ```ts
   * await tx.cartItem.deleteMany({ where: { variantId: { in: oldVariantIds } } });
   * await tx.productVariant.deleteMany({ where: { productId: id } });
   * await tx.productVariant.createMany({ data: variants.map(...) });
   * ```
   *
   * Or **les deux formulaires d'administration envoient `variants` à chaque
   * enregistrement**, même quand le vendeur n'a corrigé qu'une faute de frappe
   * dans une description. Conséquences, toutes silencieuses :
   *
   * 1. le produit disparaissait du panier de **tous** les clients qui l'y
   *    avaient mis, sans qu'aucun ne soit averti ;
   * 2. les identifiants de variantes changeaient à chaque sauvegarde, donc tout
   *    client détenant une réponse en cache (cache de session mobile, cache web)
   *    poussait ensuite un `variantId` qui n'existait plus ;
   * 3. les lignes étant réinsérées, l'ordre des variantes changeait — et avec
   *    lui le prix affiché sur les deux catalogues, alors que rien n'avait bougé
   *    métier.
   *
   * ## Ce qu'on fait à la place
   *
   * Chaque variante soumise **avec un `id` connu** est mise à jour sur place :
   * son identifiant survit, donc les paniers aussi. Une variante sans `id` est
   * créée. Seules celles réellement retirées de la liste sont supprimées — et
   * elles seules emportent leurs `CartItem`, parce que la clé étrangère l'exige.
   *
   * `UpdateProductVariantDto.id` existait déjà et n'était **jamais lu** :
   * l'information nécessaire était présente dans la requête depuis le début.
   *
   * ⚠️ Un `id` inconnu (variante d'un autre produit, identifiant inventé) est
   * traité comme une création, jamais comme une mise à jour : sans ce filtre,
   * un vendeur pourrait réécrire le prix de la variante d'un concurrent en
   * postant son identifiant.
   */
  private async reconcileVariants(
    tx: Prisma.TransactionClient,
    productId: string,
    variants: { id?: string; label?: string; prix?: number }[],
    prixOriginal: number,
  ): Promise<void> {
    const existing = await tx.productVariant.findMany({
      where: { productId },
      select: { id: true },
    });
    const existingIds = new Set(existing.map((v) => v.id));

    // Liste vide = « remets-moi une variante par défaut », comportement
    // historique conservé. On la traite comme une soumission normale pour ne
    // pas avoir deux chemins d'écriture.
    const submitted =
      variants.length > 0
        ? variants
        : [{ id: undefined, label: 'Standard', prix: prixOriginal }];

    const keptIds = new Set(
      submitted
        .map((v) => v.id)
        .filter((id): id is string => !!id && existingIds.has(id)),
    );

    const removedIds = [...existingIds].filter((id) => !keptIds.has(id));
    if (removedIds.length > 0) {
      // Seules les variantes qui disparaissent vraiment emportent les lignes de
      // panier qui les référencent : `CartItem.variantId` est une clé étrangère,
      // la suppression échouerait sinon. Les variantes conservées gardent leurs
      // paniers intacts — c'est tout l'objet de ce correctif.
      await tx.cartItem.deleteMany({ where: { variantId: { in: removedIds } } });
      await tx.productVariant.deleteMany({ where: { id: { in: removedIds } } });
    }

    for (const variant of submitted) {
      if (variant.id && keptIds.has(variant.id)) {
        await tx.productVariant.update({
          where: { id: variant.id },
          data: {
            label: variant.label ?? null,
            // `prix` est facultatif au DTO : absent, on **garde celui en base**.
            // L'ancien code écrivait `prix: undefined` dans un `createMany`, ce
            // qui faisait échouer toute la requête — modifier le seul libellé
            // d'une variante était donc impossible.
            ...(variant.prix !== undefined && { prix: variant.prix }),
          },
        });
      } else {
        await tx.productVariant.create({
          data: {
            label: variant.label,
            // Une création, elle, doit porter un prix : à défaut, celui du
            // produit — c'est déjà la convention de `create()`.
            prix: variant.prix ?? prixOriginal,
            productId,
          },
        });
      }
    }
  }

  /**
   * Pose un ordre d'affichage cohérent (0, 1, 2…) sur les produits fournis.
   *
   * Calqué trait pour trait sur `CategoriesService.reorder`, qui a déjà résolu
   * les mêmes questions :
   *
   * - le vendeur cible vient de `resolveTargetRestaurant`, **jamais** du corps
   *   de la requête — un RESTAURATEUR reste chez lui même s'il connaît
   *   l'identifiant d'une autre boutique ;
   * - un identifiant étranger fait échouer **l'appel entier** plutôt que d'être
   *   ignoré en silence : un réordonnancement partiellement appliqué laisserait
   *   un ordre faux, et personne ne le saurait ;
   * - l'écriture est une transaction : on ne veut pas d'un état intermédiaire où
   *   la moitié de la carte porte l'ancien ordre.
   *
   * ⚠️ Les produits retirés (`deletedAt`) sont exclus de la vérification de
   * propriété : ils ne sont plus gérables, et les inclure permettrait de les
   * faire réapparaître dans un ordre.
   */
  async reorder(dto: ReorderProductsDto, firebaseUid: string) {
    const restaurant = await this.access.resolveTargetRestaurant(
      firebaseUid,
      dto.restaurantId,
    );

    const owned = await this.prisma.product.findMany({
      where: {
        id: { in: dto.productIds },
        restaurantId: restaurant.id,
        deletedAt: null,
      },
      select: { id: true },
    });

    if (owned.length !== dto.productIds.length) {
      throw new ForbiddenException(
        "Certains produits n'appartiennent pas à ce vendeur.",
      );
    }

    await this.prisma.$transaction(
      dto.productIds.map((productId, index) =>
        this.prisma.product.update({
          where: { id: productId },
          data: { displayOrder: index },
        }),
      ),
    );

    if (restaurant.onBehalfOf) {
      await this.recordAdminCatalogEdit(firebaseUid, restaurant.id, {
        entity: 'Product',
        action: 'reorder',
        count: dto.productIds.length,
      });
    }

    this.touchCatalog(restaurant.id, 'product.reordered');

    return {
      data: await this.prisma.product.findMany({
        where: { id: { in: dto.productIds } },
        orderBy: [...MENU_PRODUCTS_ORDER_BY],
        select: { id: true, nom: true, displayOrder: true, categoryId: true },
      }),
      message: 'Ordre des produits mis à jour',
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

    this.touchCatalog(product.restaurantId, 'product.removed');

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

    this.touchCatalog(product.restaurantId, 'product.availability');

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

    this.touchCatalog(product.restaurantId, 'product.stock');

    return {
      message: 'Stock mis à jour avec succès',
      data: updated,
    };
  }
}
