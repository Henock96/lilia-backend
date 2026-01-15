import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../prisma/prisma.service';
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

    // 3. Vérifier que tous les produits existent et appartiennent au restaurant
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
    const menu = await this.prisma.menuDuJour.create({
      data: {
        nom: dto.nom,
        description: dto.description,
        imageUrl: dto.imageUrl,
        prix: dto.prix,
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
      },
    });

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

    // 4. Vérifier les produits si fournis
    if (dto.products && dto.products.length > 0) {
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

    // 5. Mettre à jour le menu
    const updateData: any = {};
    if (dto.nom) updateData.nom = dto.nom;
    if (dto.description !== undefined)
      updateData.description = dto.description;
    if (dto.imageUrl !== undefined) updateData.imageUrl = dto.imageUrl;
    if (dto.prix) updateData.prix = dto.prix;
    if (dto.dateDebut) updateData.dateDebut = new Date(dto.dateDebut);
    if (dto.dateFin) updateData.dateFin = new Date(dto.dateFin);
    if (dto.isActive !== undefined) updateData.isActive = dto.isActive;

    if (dto.products && dto.products.length > 0) {
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
      },
    });

    return {
      message: 'Menu mis à jour avec succès',
      data: menu,
    };
  }

  /**
   * Supprimer un menu
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

    // 3. Supprimer le menu (cascade sur MenuProduct)
    await this.prisma.menuDuJour.delete({
      where: { id },
    });

    return {
      message: 'Menu supprimé avec succès',
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
