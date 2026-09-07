import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { AdminAuditAction, Prisma, VendorType } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { RestaurantAccessService } from '../restaurants/restaurant-access.service';
import { AdminAuditService } from '../admin-audit/admin-audit.service';
import { CreateCategoryDto } from './dto/create-category.dto';
import { UpdateCategoryDto } from './dto/update-category.dto';
import { ReorderCategoriesDto } from './dto/reorder-categories.dto';
import {
  DEFAULT_CATEGORIES_BY_VENDOR_TYPE,
  OWNER_CATEGORIES_ORDER_BY,
} from './category.includes';
import { slugifyCategoryName } from './category-slug';
import { CATALOG_CHANGED, CatalogChangedEvent } from '../events/catalog-events';

/**
 * Sections de menu d'un vendeur.
 *
 * Chaque écriture passe par `RestaurantAccessService.resolveTargetRestaurant`,
 * exactement comme les produits et les menus : c'est ce service qui décide du
 * vendeur cible, jamais le corps de la requête. Un RESTAURATEUR reste donc
 * cantonné à sa boutique même s'il connaît l'identifiant d'une autre.
 */
@Injectable()
export class CategoriesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: RestaurantAccessService,
    private readonly audit: AdminAuditService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /** Cf. `ProductCommandService.touchCatalog` — émis hors transaction. */
  private touchCatalog(restaurantId: string, reason: string): void {
    this.eventEmitter.emit(
      CATALOG_CHANGED,
      new CatalogChangedEvent(restaurantId, reason),
    );
  }

  // ─── Écritures ─────────────────────────────────────────────────────────────

  async create(dto: CreateCategoryDto, firebaseUid: string) {
    const restaurant = await this.access.resolveTargetRestaurant(
      firebaseUid,
      dto.restaurantId,
    );

    const slug = slugifyCategoryName(dto.nom);

    // Placée en fin de liste par défaut : une nouvelle section ne doit pas
    // s'insérer en tête de la carte d'un vendeur sans qu'il l'ait demandé.
    const displayOrder =
      dto.displayOrder ?? (await this.nextDisplayOrder(restaurant.id));

    const category = await this.createOrConflict({
      restaurantId: restaurant.id,
      nom: dto.nom,
      slug,
      description: dto.description,
      imageUrl: dto.imageUrl,
      displayOrder,
      isActive: dto.isActive ?? true,
    });

    if (restaurant.onBehalfOf) {
      await this.recordAdminCatalogEdit(firebaseUid, restaurant.id, {
        entity: 'Category',
        categoryId: category.id,
        nom: category.nom,
      });
    }

    this.touchCatalog(restaurant.id, 'category.created');

    return { data: category, message: 'Catégorie créée avec succès' };
  }

  async update(id: string, dto: UpdateCategoryDto, firebaseUid: string) {
    const existing = await this.findOwnedOrThrow(id, firebaseUid);

    const data: Prisma.CategoryUpdateInput = {
      ...(dto.nom !== undefined && {
        nom: dto.nom,
        slug: slugifyCategoryName(dto.nom),
      }),
      ...(dto.description !== undefined && { description: dto.description }),
      ...(dto.imageUrl !== undefined && { imageUrl: dto.imageUrl }),
      ...(dto.displayOrder !== undefined && { displayOrder: dto.displayOrder }),
      ...(dto.isActive !== undefined && { isActive: dto.isActive }),
    };

    try {
      const updated = await this.prisma.category.update({
        where: { id },
        data,
      });
      this.touchCatalog(updated.restaurantId, 'category.updated');
      return { data: updated, message: 'Catégorie mise à jour avec succès' };
    } catch (error) {
      throw this.translateUniqueViolation(error, dto.nom ?? existing.nom);
    }
  }

  /**
   * Supprime une section **sans jamais supprimer de produit**.
   *
   * Les produits sont détachés (`categoryId = null`) dans la même transaction :
   * la clé étrangère composite est en `Restrict`, donc l'ordre n'est pas un
   * détail de style — c'est ce qui fait que la suppression aboutit. Un produit
   * détaché reste vendable et remonte en « Autres » côté client.
   */
  async remove(id: string, firebaseUid: string) {
    const category = await this.findOwnedOrThrow(id, firebaseUid);

    const detached = await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.product.updateMany({
        where: { categoryId: id },
        data: { categoryId: null },
      });
      await tx.category.delete({ where: { id } });
      return count;
    });

    this.touchCatalog(category.restaurantId, 'category.removed');

    return {
      message:
        detached > 0
          ? `Catégorie supprimée. ${detached} produit(s) sont désormais sans catégorie et restent en vente.`
          : 'Catégorie supprimée avec succès',
      data: { detachedProducts: detached },
    };
  }

  /**
   * Pose un ordre d'affichage cohérent (0, 1, 2…) sur les catégories fournies.
   *
   * Toutes doivent appartenir au vendeur cible : un identifiant étranger dans la
   * liste fait échouer l'appel entier plutôt que d'être ignoré en silence, sans
   * quoi un réordonnancement partiellement appliqué laisserait un ordre faux.
   */
  async reorder(dto: ReorderCategoriesDto, firebaseUid: string) {
    const restaurant = await this.access.resolveTargetRestaurant(
      firebaseUid,
      dto.restaurantId,
    );

    const owned = await this.prisma.category.findMany({
      where: { id: { in: dto.categoryIds }, restaurantId: restaurant.id },
      select: { id: true },
    });

    if (owned.length !== dto.categoryIds.length) {
      throw new ForbiddenException(
        "Certaines catégories n'appartiennent pas à ce vendeur.",
      );
    }

    await this.prisma.$transaction(
      dto.categoryIds.map((categoryId, index) =>
        this.prisma.category.update({
          where: { id: categoryId },
          data: { displayOrder: index },
        }),
      ),
    );

    this.touchCatalog(restaurant.id, 'category.reordered');

    return {
      data: await this.prisma.category.findMany({
        where: { restaurantId: restaurant.id },
        orderBy: [...OWNER_CATEGORIES_ORDER_BY],
      }),
      message: 'Ordre des catégories mis à jour',
    };
  }

  /**
   * Sections créées d'office à la naissance d'un vendeur.
   *
   * Appelée **dans la transaction de création** : si le vendeur existe, ses
   * sections existent. `skipDuplicates` rend l'appel rejouable (reprise
   * d'onboarding, seed) sans faire échouer la création pour une section déjà
   * posée.
   */
  async createDefaultsFor(
    restaurantId: string,
    vendorType: VendorType,
    tx: Prisma.TransactionClient = this.prisma,
  ): Promise<number> {
    const noms = DEFAULT_CATEGORIES_BY_VENDOR_TYPE[vendorType] ?? [];
    if (noms.length === 0) return 0;

    const { count } = await tx.category.createMany({
      data: noms.map((nom, index) => ({
        restaurantId,
        nom,
        slug: slugifyCategoryName(nom),
        displayOrder: index,
      })),
      skipDuplicates: true,
    });
    return count;
  }

  // ─── Lectures ──────────────────────────────────────────────────────────────

  /**
   * Catégories d'un vendeur, vue **propriétaire / administration**.
   *
   * ⚠️ Le filtre historique était `products: { some: { restaurantId } }` — donc
   * « les catégories qui ont déjà au moins un produit ici ». Une section créée
   * disparaissait à la seconde où on la rafraîchissait, et sur le web le
   * sélecteur du formulaire produit restait masqué : impossible de catégoriser
   * un premier produit. Une catégorie existe parce qu'elle est en base, pas
   * parce qu'elle est remplie.
   */
  async findAllForOwner(firebaseUid: string, restaurantId?: string) {
    const restaurant = await this.access.resolveTargetRestaurant(
      firebaseUid,
      restaurantId,
    );

    const categories = await this.prisma.category.findMany({
      where: { restaurantId: restaurant.id },
      orderBy: [...OWNER_CATEGORIES_ORDER_BY],
      include: {
        // Compte les produits réellement au catalogue : le `_count` brut
        // incluait les produits retirés et affichait un chiffre faux.
        _count: { select: { products: { where: { deletedAt: null } } } },
      },
    });

    return { data: categories, count: categories.length };
  }

  // ⚠️ `findPublicByRestaurant` a été **supprimée** (07/09/2026).
  //
  // Elle servait `GET /categories/restaurant/:restaurantId` — sections actives
  // et non vides d'un vendeur — et n'a jamais eu le moindre appelant sur les
  // cinq dépôts. Les sections de la carte arrivent embarquées dans
  // `GET /vendors/:id` (`PUBLIC_CATEGORIES_ARGS`), et le filtre « non vide »
  // est appliqué par les clients, sur les produits qu'ils ont **reçus** — donc
  // après la borne `MENU_PRODUCTS_LIMIT`, ce que cette méthode ne pouvait pas
  // faire. Voir l'en-tête de `categories.controller.ts`.

  async findOne(id: string, firebaseUid: string) {
    const category = await this.findOwnedOrThrow(id, firebaseUid);
    return { data: category };
  }

  // ─── Internes ──────────────────────────────────────────────────────────────

  /**
   * Charge une catégorie et vérifie que l'appelant a le droit d'y toucher.
   *
   * L'ADMIN passe partout ; le RESTAURATEUR uniquement sur son vendeur. Le 404
   * précède volontairement le 403 : un identifiant inexistant ne doit pas se
   * distinguer d'un identifiant appartenant à autrui.
   */
  private async findOwnedOrThrow(id: string, firebaseUid: string) {
    const category = await this.prisma.category.findUnique({
      where: { id },
      include: { restaurant: { select: { ownerId: true } } },
    });
    if (!category) {
      throw new NotFoundException(`Catégorie "${id}" non trouvée.`);
    }

    const caller = await this.prisma.user.findUnique({
      where: { firebaseUid },
      select: { id: true, role: true },
    });
    if (!caller) {
      throw new NotFoundException('Utilisateur non trouvé.');
    }

    if (caller.role !== 'ADMIN' && category.restaurant.ownerId !== caller.id) {
      throw new ForbiddenException(
        'Cette catégorie appartient à un autre vendeur.',
      );
    }

    const { restaurant: _restaurant, ...rest } = category;
    return rest;
  }

  /** Ordre suivant, pour poser une nouvelle section en fin de carte. */
  private async nextDisplayOrder(restaurantId: string): Promise<number> {
    const last = await this.prisma.category.findFirst({
      where: { restaurantId },
      orderBy: { displayOrder: 'desc' },
      select: { displayOrder: true },
    });
    return last ? last.displayOrder + 1 : 0;
  }

  private async createOrConflict(data: Prisma.CategoryUncheckedCreateInput) {
    try {
      return await this.prisma.category.create({ data });
    } catch (error) {
      throw this.translateUniqueViolation(error, data.nom);
    }
  }

  /**
   * P2002 sur `(restaurantId, slug)` → 409 avec un message métier.
   *
   * On laisse la base arbitrer plutôt que de faire un `findFirst` préalable :
   * un contrôle en lecture puis écriture laisse passer deux créations
   * concurrentes du même nom, et c'est exactement le cas qu'une contrainte
   * d'unicité existe pour couvrir.
   */
  private translateUniqueViolation(error: unknown, nom: string): unknown {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      return new ConflictException(
        `Vous avez déjà une catégorie « ${nom} ». Choisissez un autre nom.`,
      );
    }
    return error;
  }

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
}
