/* eslint-disable prettier/prettier */
import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  CATALOG_CHANGED,
  CatalogChangedEvent,
} from '../events/catalog-events';
import { PrismaService } from '../../prisma/prisma.service';
import { MENU_VARIANTS_ORDER_BY } from '../products/vendor-menu.include';
import { CreateMenuDto, UpdateMenuDto } from './dto';
import { MenuCreatedEvent } from '../events/menu-events';
import { RestaurantAccessService } from '../restaurants/restaurant-access.service';
import { AdminAuditService } from '../admin-audit/admin-audit.service';
import { AdminAuditAction } from '@prisma/client';

/**
 * Authoring des menus (extrait de MenusService — LIL-141).
 *
 * Création (COMBO / PLAT_SPECIAL avec produit phantom) et mise à jour du
 * contenu d'un menu. Émet `menu.created` à la création. Les opérations de
 * cycle de vie plus légères (suppression, stock, activation) vivent dans
 * MenuLifecycleService — séparées pour rester sous la cible ~400 LOC.
 */
@Injectable()
export class MenuCommandService {
  private readonly logger = new Logger(MenuCommandService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
    private readonly access: RestaurantAccessService,
    private readonly audit: AdminAuditService,
  ) {}

  /** Cf. `ProductCommandService.touchCatalog` — émis hors transaction. */
  private touchCatalog(restaurantId: string, reason: string): void {
    this.eventEmitter.emit(
      CATALOG_CHANGED,
      new CatalogChangedEvent(restaurantId, reason),
    );
  }

  /**
   * F3-10 — composants d'un menu COMBO, chacun avec **son** format.
   *
   * Le panier prenait `variants[0]` d'une lecture non triée : tant que tous
   * les formats consommaient 1 unité, c'était sans effet sur le stock ; avec
   * un « carton de 6 », un menu aurait pu consommer 6 bouteilles au lieu
   * d'une. Le vendeur désigne donc le format ; à défaut (application
   * installée), on prend le premier format **à 1 unité** dans l'ordre des
   * catalogues (prix croissant) — jamais un carton par hasard.
   *
   * Propriété vérifiée ici (produit du vendeur) et en base (clé étrangère
   * composite `MenuProduct(variantId, productId)`).
   */
  private async resolveComponents(
    products: { productId: string; variantId?: string; ordre?: number }[],
    restaurantId: string,
    /** Formats actuels du menu : une application installée qui renvoie la
     *  composition sans `variantId` ne doit pas défaire le choix du vendeur. */
    previous: ReadonlyMap<string, string> = new Map(),
  ): Promise<{ productId: string; variantId: string; ordre: number }[]> {
    const productIds = products.map((p) => p.productId);
    const found = await this.prisma.product.findMany({
      where: { id: { in: productIds }, restaurantId },
      select: {
        id: true,
        nom: true,
        variants: {
          orderBy: [...MENU_VARIANTS_ORDER_BY],
          select: { id: true, stockConsumption: true },
        },
      },
    });
    if (found.length !== new Set(productIds).size) {
      throw new BadRequestException(
        'Certains produits n\'existent pas ou n\'appartiennent pas à votre restaurant.',
      );
    }
    const byId = new Map(found.map((p) => [p.id, p]));
    return products.map((component) => {
      const product = byId.get(component.productId)!;
      const wanted = component.variantId ?? previous.get(component.productId);
      const variant = wanted
        ? product.variants.find((v) => v.id === wanted)
        : (product.variants.find((v) => v.stockConsumption === 1) ??
          product.variants[0]);
      if (!variant) {
        throw new BadRequestException(
          component.variantId
            ? `Le format choisi n'appartient pas à « ${product.nom} ».`
            : `Le produit « ${product.nom} » n'a pas de format disponible.`,
        );
      }
      return {
        productId: component.productId,
        variantId: variant.id,
        ordre: component.ordre ?? 0,
      };
    });
  }

  /**
   * Créer un nouveau menu pour un restaurant
   * Seul le propriétaire du restaurant peut créer un menu
   * Supporte deux types : COMBO (multi-produits) et PLAT_SPECIAL (plat unique auto-cree)
   */
  async create(dto: CreateMenuDto, firebaseUid: string) {
    // 1. Déterminer le vendeur cible. Sans `restaurantId`, c'est celui de
    // l'appelant (cas nominal) ; avec, seul un ADMIN passe — ce qui lui permet
    // enfin d'amorcer le catalogue d'un vendeur en cours d'onboarding.
    const restaurant = await this.access.resolveTargetRestaurant(
      firebaseUid,
      dto.restaurantId,
    );

    // 2. Valider les dates
    const dateDebut = new Date(dto.dateDebut);
    const dateFin = new Date(dto.dateFin);

    if (dateFin <= dateDebut) {
      throw new BadRequestException(
        'La date de fin doit être après la date de début.',
      );
    }

    const menuType = dto.type || 'COMBO';

    const menuInclude = {
      products: {
        include: {
          product: {
            include: {
              category: true,
              variants: true,
            },
          },
        },
        orderBy: {
          ordre: 'asc' as const,
        },
      },
      restaurant: {
        select: {
          id: true,
          nom: true,
          imageUrl: true,
        },
      },
      images: { orderBy: [{ isCover: 'desc' as const }, { displayOrder: 'asc' as const }] },
    };

    let menu;

    if (menuType === 'PLAT_SPECIAL') {
      // PLAT_SPECIAL : auto-creer un produit phantom + variante Standard
      menu = await this.prisma.$transaction(async (tx) => {
        // 3a. Creer le produit phantom
        const phantomProduct = await tx.product.create({
          data: {
            nom: dto.nom,
            description: dto.description || dto.ingredients,
            imageUrl: dto.imageUrl,
            prixOriginal: dto.prix,
            restaurantId: restaurant.id,
          },
        });

        // 3b. Creer la variante Standard
        const standard = await tx.productVariant.create({
          data: {
            label: 'Standard',
            prix: dto.prix,
            productId: phantomProduct.id,
          },
        });

        // 3c. Creer le menu avec lien vers le produit phantom
        return tx.menuDuJour.create({
          data: {
            nom: dto.nom,
            description: dto.description,
            imageUrl: dto.imageUrl,
            prix: dto.prix,
            type: 'PLAT_SPECIAL',
            ingredients: dto.ingredients,
            dateDebut: dateDebut,
            dateFin: dateFin,
            isActive: dto.isActive ?? true,
            restaurantId: restaurant.id,
            products: {
              create: {
                productId: phantomProduct.id,
                variantId: standard.id,
                ordre: 0,
              },
            },
          },
          include: menuInclude,
        });
      });

      this.logger.log(
        `🍽️ PLAT_SPECIAL cree: menu=${menu.id}, produit phantom=${menu.products[0]?.productId}`,
      );
    } else {
      // COMBO : comportement classique
      // 3. Vérifier que tous les produits existent et appartiennent au restaurant
      if (!dto.products || dto.products.length === 0) {
        throw new BadRequestException(
          'Un menu COMBO doit contenir au moins un produit.',
        );
      }

      const components = await this.resolveComponents(dto.products, restaurant.id);

      // 4. Créer le menu avec ses produits
      menu = await this.prisma.menuDuJour.create({
        data: {
          nom: dto.nom,
          description: dto.description,
          imageUrl: dto.imageUrl,
          prix: dto.prix,
          type: 'COMBO',
          dateDebut: dateDebut,
          dateFin: dateFin,
          isActive: dto.isActive ?? true,
          restaurantId: restaurant.id,
          products: { create: components },
        },
        include: menuInclude,
      });
    }

    // 5. Émettre l'événement de création de menu pour envoyer les notifications
    this.logger.log(`📢 Emitting menu.created event for menu: ${menu.id}`);
    this.eventEmitter.emit(
      'menu.created',
      new MenuCreatedEvent(
        menu.id,
        restaurant.id,
        {
          nom: menu.nom,
          description: menu.description,
          prix: menu.prix,
          imageUrl: menu.imageUrl,
          restaurantName: menu.restaurant.nom,
          dateDebut: menu.dateDebut,
          dateFin: menu.dateFin,
          productCount: menu.products.length,
        },
      ),
    );

    // Écriture d'un administrateur au nom d'un vendeur : traçable, comme la
    // création de produit par le même chemin.
    if (restaurant.onBehalfOf) {
      const actor = await this.prisma.user.findUnique({
        where: { firebaseUid },
        select: { id: true },
      });
      if (actor) {
        await this.audit.record({
          actorId: actor.id,
          action: AdminAuditAction.VENDOR_CATALOG_EDITED,
          targetType: 'Restaurant',
          targetId: restaurant.id,
          metadata: { entity: 'MenuDuJour', menuId: menu.id, nom: menu.nom },
        });
      }
    }

    this.touchCatalog(menu.restaurantId, 'menu.created');

    return {
      message: 'Menu créé avec succès',
      data: menu,
    };
  }

  /**
   * Mettre à jour un menu
   * Pour PLAT_SPECIAL, met aussi a jour le produit phantom associe
   */
  async update(id: string, dto: UpdateMenuDto, firebaseUid: string) {
    // 1. Vérifier que le menu existe
    const existingMenu = await this.prisma.menuDuJour.findUnique({
      where: { id },
      include: {
        restaurant: {
          include: {
            owner: true,
          },
        },
        products: true,
      },
    });

    if (!existingMenu) {
      throw new NotFoundException('Menu non trouvé');
    }

    // 2. Vérifier que l'utilisateur est le propriétaire du restaurant
    if (existingMenu.restaurant.owner.firebaseUid !== firebaseUid) {
      throw new ForbiddenException(
        'Vous n\'êtes pas autorisé à modifier ce menu',
      );
    }

    // 3. Valider les dates si elles sont fournies
    if (dto.dateDebut || dto.dateFin) {
      const dateDebut = dto.dateDebut
        ? new Date(dto.dateDebut)
        : existingMenu.dateDebut;
      const dateFin = dto.dateFin
        ? new Date(dto.dateFin)
        : existingMenu.dateFin;

      if (dateFin <= dateDebut) {
        throw new BadRequestException(
          'La date de fin doit être après la date de début.',
        );
      }
    }

    // 4. Si PLAT_SPECIAL, mettre a jour le produit phantom
    if (existingMenu.type === 'PLAT_SPECIAL' && existingMenu.products.length > 0) {
      const phantomProductId = existingMenu.products[0].productId;
      const productUpdate: any = {};
      if (dto.nom) productUpdate.nom = dto.nom;
      if (dto.description !== undefined) productUpdate.description = dto.description;
      if (dto.imageUrl !== undefined) productUpdate.imageUrl = dto.imageUrl;
      if (dto.prix) productUpdate.prixOriginal = dto.prix;

      if (Object.keys(productUpdate).length > 0) {
        await this.prisma.product.update({
          where: { id: phantomProductId },
          data: productUpdate,
        });

        // Mettre a jour le prix de la variante Standard si le prix change
        if (dto.prix) {
          await this.prisma.productVariant.updateMany({
            where: { productId: phantomProductId, label: 'Standard' },
            data: { prix: dto.prix },
          });
        }
      }
    }

    // 5. Vérifier les produits si fournis (COMBO uniquement)
    let components: { productId: string; variantId: string; ordre: number }[] = [];
    if (existingMenu.type !== 'PLAT_SPECIAL' && dto.products && dto.products.length > 0) {
      components = await this.resolveComponents(
        dto.products,
        existingMenu.restaurantId,
        new Map(existingMenu.products.map((mp) => [mp.productId, mp.variantId])),
      );

      // Supprimer les anciennes relations et créer les nouvelles
      await this.prisma.menuProduct.deleteMany({
        where: { menuId: id },
      });
    }

    // 6. Mettre à jour le menu
    const updateData: any = {};
    if (dto.nom) updateData.nom = dto.nom;
    if (dto.description !== undefined)
      updateData.description = dto.description;
    if (dto.imageUrl !== undefined) updateData.imageUrl = dto.imageUrl;
    if (dto.prix) updateData.prix = dto.prix;
    if (dto.dateDebut) updateData.dateDebut = new Date(dto.dateDebut);
    if (dto.dateFin) updateData.dateFin = new Date(dto.dateFin);
    if (dto.isActive !== undefined) updateData.isActive = dto.isActive;
    if (dto.ingredients !== undefined) updateData.ingredients = dto.ingredients;

    if (existingMenu.type !== 'PLAT_SPECIAL' && dto.products && dto.products.length > 0) {
      updateData.products = { create: components };
    }

    const menu = await this.prisma.menuDuJour.update({
      where: { id },
      data: updateData,
      include: {
        products: {
          include: {
            product: {
              include: {
                category: true,
                variants: true,
              },
            },
          },
          orderBy: {
            ordre: 'asc',
          },
        },
        restaurant: {
          select: {
            id: true,
            nom: true,
            imageUrl: true,
          },
        },
        images: { orderBy: [{ isCover: 'desc' }, { displayOrder: 'asc' }] },
      },
    });

    this.touchCatalog(menu.restaurantId, 'menu.updated');

    return {
      message: 'Menu mis à jour avec succès',
      data: menu,
    };
  }
}
