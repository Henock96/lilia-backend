/* eslint-disable prettier/prettier */
import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateMenuDto, UpdateMenuDto } from './dto';
import { MenuCreatedEvent } from '../events/menu-events';

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
  ) {}

  /**
   * Créer un nouveau menu pour un restaurant
   * Seul le propriétaire du restaurant peut créer un menu
   * Supporte deux types : COMBO (multi-produits) et PLAT_SPECIAL (plat unique auto-cree)
   */
  async create(dto: CreateMenuDto, firebaseUid: string) {
    // 1. Vérifier que l'utilisateur possède un restaurant
    const restaurant = await this.prisma.restaurant.findFirst({
      where: {
        owner: {
          firebaseUid: firebaseUid,
        },
      },
    });

    if (!restaurant) {
      throw new ForbiddenException(
        'Vous devez posséder un restaurant pour créer un menu.',
      );
    }

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
        await tx.productVariant.create({
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

      const productIds = dto.products.map((p) => p.productId);
      const products = await this.prisma.product.findMany({
        where: {
          id: { in: productIds },
          restaurantId: restaurant.id,
        },
      });

      if (products.length !== productIds.length) {
        throw new BadRequestException(
          'Certains produits n\'existent pas ou n\'appartiennent pas à votre restaurant.',
        );
      }

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
          products: {
            create: dto.products.map((p) => ({
              productId: p.productId,
              ordre: p.ordre ?? 0,
            })),
          },
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
    if (existingMenu.type !== 'PLAT_SPECIAL' && dto.products && dto.products.length > 0) {
      const productIds = dto.products.map((p) => p.productId);
      const products = await this.prisma.product.findMany({
        where: {
          id: { in: productIds },
          restaurantId: existingMenu.restaurantId,
        },
      });

      if (products.length !== productIds.length) {
        throw new BadRequestException(
          'Certains produits n\'existent pas ou n\'appartiennent pas à votre restaurant.',
        );
      }

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
      updateData.products = {
        create: dto.products.map((p) => ({
          productId: p.productId,
          ordre: p.ordre ?? 0,
        })),
      };
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

    return {
      message: 'Menu mis à jour avec succès',
      data: menu,
    };
  }
}
