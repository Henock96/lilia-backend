/* eslint-disable prettier/prettier */
import {
  Injectable,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Lectures des menus (extrait de MenusService — LIL-141).
 * Catalogue, menus actifs du jour, détail et menus d'un restaurateur.
 */
@Injectable()
export class MenuQueryService {
  constructor(private readonly prisma: PrismaService) {}

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
}
