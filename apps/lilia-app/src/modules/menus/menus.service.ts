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

@Injectable()
export class MenusService {
  private readonly logger = new Logger(MenusService.name);

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
   * Obtenir tous les menus avec filtres optionnels
   */
  async findAll(filters?: {
    restaurantId?: string;
    isActive?: boolean;
    includeExpired?: boolean;
  }) {
    const where: any = {};

    if (filters?.restaurantId) {
      where.restaurantId = filters.restaurantId;
    }

    if (filters?.isActive !== undefined) {
      where.isActive = filters.isActive;
    }

    // Par défaut, ne pas inclure les menus expirés
    if (!filters?.includeExpired) {
      where.dateFin = {
        gte: new Date(),
      };
    }

    const menus = await this.prisma.menuDuJour.findMany({
      where,
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
      orderBy: {
        dateDebut: 'desc',
      },
    });

    return {
      message: 'Menus récupérés avec succès',
      data: menus,
      count: menus.length,
    };
  }

  /**
   * Obtenir les menus actifs du jour pour un restaurant
   */
  async getActiveMenus(restaurantId?: string) {
    const now = new Date();
    const where: any = {
      isActive: true,
      dateDebut: { lte: now },
      dateFin: { gte: now },
    };

    if (restaurantId) {
      where.restaurantId = restaurantId;
    }

    const menus = await this.prisma.menuDuJour.findMany({
      where,
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
      orderBy: {
        dateDebut: 'desc',
      },
    });

    return {
      message: 'Menus actifs récupérés avec succès',
      data: menus,
      count: menus.length,
    };
  }

  /**
   * Obtenir un menu par son ID
   */
  async findOne(id: string) {
    const menu = await this.prisma.menuDuJour.findUnique({
      where: { id },
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
            adresse: true,
            phone: true,
            imageUrl: true,
          },
        },
        images: { orderBy: [{ isCover: 'desc' }, { displayOrder: 'asc' }] },
      },
    });

    if (!menu) {
      throw new NotFoundException('Menu non trouvé');
    }

    return {
      message: 'Menu récupéré avec succès',
      data: menu,
    };
  }

  /**
   * Obtenir tous les menus d'un restaurant
   */
  async findByRestaurant(firebaseUid: string) {
    const restaurant = await this.prisma.restaurant.findFirst({
      where: {
        owner: {
          firebaseUid: firebaseUid,
        },
      },
    });

    if (!restaurant) {
      throw new ForbiddenException('Restaurant non trouvé');
    }

    const menus = await this.prisma.menuDuJour.findMany({
      where: {
        restaurantId: restaurant.id,
      },
      include: {
        products: {
          include: {
            product: {
              include: {
                category: true,
              },
            },
          },
          orderBy: {
            ordre: 'asc',
          },
        },
        images: { orderBy: [{ isCover: 'desc' }, { displayOrder: 'asc' }] },
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    return {
      message: 'Menus du restaurant récupérés avec succès',
      data: menus,
      count: menus.length,
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

  /**
   * Supprimer un menu
   * Pour PLAT_SPECIAL, supprime aussi le produit phantom associe
   */
  async remove(id: string, firebaseUid: string) {
    // 1. Vérifier que le menu existe
    const menu = await this.prisma.menuDuJour.findUnique({
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

    if (!menu) {
      throw new NotFoundException('Menu non trouvé');
    }

    // 2. Vérifier que l'utilisateur est le propriétaire du restaurant
    if (menu.restaurant.owner.firebaseUid !== firebaseUid) {
      throw new ForbiddenException(
        'Vous n\'êtes pas autorisé à supprimer ce menu',
      );
    }

    // 3. Si PLAT_SPECIAL, recuperer l'ID du produit phantom avant suppression
    const phantomProductId =
      menu.type === 'PLAT_SPECIAL' && menu.products.length > 0
        ? menu.products[0].productId
        : null;

    // 4. Supprimer le menu (cascade sur MenuProduct)
    await this.prisma.menuDuJour.delete({
      where: { id },
    });

    // 5. Supprimer le produit phantom si PLAT_SPECIAL
    if (phantomProductId) {
      try {
        // Supprimer les variantes puis le produit
        await this.prisma.productVariant.deleteMany({
          where: { productId: phantomProductId },
        });
        await this.prisma.product.delete({
          where: { id: phantomProductId },
        });
        this.logger.log(
          `🗑️ Produit phantom ${phantomProductId} supprime avec le menu PLAT_SPECIAL ${id}`,
        );
      } catch (error) {
        // Le produit phantom peut etre reference par des commandes passees,
        // dans ce cas on le laisse (orphelin mais necessaire pour l'historique)
      }
    }

    return {
      message: 'Menu supprimé avec succès',
    };
  }

  /**
   * Met à jour le stock d'un menu
   */
  async updateStock(menuId: string, stockQuotidien: number | null, firebaseUid: string) {
    const menu = await this.prisma.menuDuJour.findUnique({
      where: { id: menuId },
      include: { restaurant: { include: { owner: true } } },
    });

    if (!menu) {
      throw new NotFoundException('Menu non trouvé');
    }

    const user = await this.prisma.user.findFirst({ where: { firebaseUid } });
    if (!user) throw new NotFoundException('Utilisateur non trouvé.');

    if (user.role !== 'ADMIN' && menu.restaurant.owner.firebaseUid !== firebaseUid) {
      throw new ForbiddenException(
        'Vous n\'êtes pas autorisé à modifier le stock de ce menu',
      );
    }

    const updated = await this.prisma.menuDuJour.update({
      where: { id: menuId },
      data: {
        stockQuotidien: stockQuotidien,
        stockRestant: stockQuotidien,
      },
    });

    return {
      message: 'Stock du menu mis à jour avec succès',
      data: updated,
    };
  }

  /**
   * Désactiver/activer un menu
   */
  async toggleActive(id: string, firebaseUid: string) {
    const menu = await this.prisma.menuDuJour.findUnique({
      where: { id },
      include: {
        restaurant: {
          include: {
            owner: true,
          },
        },
      },
    });

    if (!menu) {
      throw new NotFoundException('Menu non trouvé');
    }

    if (menu.restaurant.owner.firebaseUid !== firebaseUid) {
      throw new ForbiddenException(
        'Vous n\'êtes pas autorisé à modifier ce menu',
      );
    }

    const updatedMenu = await this.prisma.menuDuJour.update({
      where: { id },
      data: {
        isActive: !menu.isActive,
      },
    });

    return {
      message: `Menu ${updatedMenu.isActive ? 'activé' : 'désactivé'} avec succès`,
      data: updatedMenu,
    };
  }
}
