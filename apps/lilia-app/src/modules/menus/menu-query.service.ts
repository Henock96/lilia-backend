import {
  Injectable,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { PUBLIC_VENDOR_WHERE } from '../../common/vendor-visibility';
import { availableProductWhere } from '../products/product-availability';

/** Taille de page par défaut des listes publiques de menus. */
const MENUS_DEFAULT_LIMIT = 50;

/**
 * Lectures des menus (extrait de MenusService — LIL-141).
 * Catalogue, menus actifs du jour, détail et menus d'un restaurateur.
 */
@Injectable()
export class MenuQueryService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Include partagé par les lectures de menus.
   *
   * `scope: 'public'` exclut des menus les produits retirés ou indisponibles :
   * un menu COMBO dont un composant a été retiré du catalogue continuait
   * d'afficher ce composant au client (fix PRD-03, volet menus).
   */
  private menuInclude(scope: 'public' | 'owner', now = new Date()) {
    return {
      products: {
        ...(scope === 'public'
          ? {
              where: {
                product: availableProductWhere(this.prisma.product.fields, now),
              },
            }
          : {}),
        include: {
          product: { include: { category: true, variants: true } },
        },
        orderBy: { ordre: 'asc' as const },
      },
      restaurant: { select: { id: true, nom: true, imageUrl: true } },
      images: {
        orderBy: [
          { isCover: 'desc' as const },
          { displayOrder: 'asc' as const },
        ],
      },
    };
  }

  /**
   * Catalogue public des menus — **borné et filtré** (fix SEC-02).
   *
   * La méthode construisait son `where` sans **aucune** condition sur le
   * vendeur : les menus d'un commerce en DRAFT, non approuvé ou suspendu
   * étaient servis publiquement, avec leurs produits, variantes et images. Et
   * sans `take`, un `findMany` à trois niveaux d'`include` chargeait toute la
   * table sur une route non authentifiée.
   */
  async findAll(filters?: {
    restaurantId?: string;
    isActive?: boolean;
    includeExpired?: boolean;
    page?: number;
    limit?: number;
  }) {
    const page = filters?.page ?? 1;
    const limit = filters?.limit ?? MENUS_DEFAULT_LIMIT;

    const where: Prisma.MenuDuJourWhereInput = {
      restaurant: PUBLIC_VENDOR_WHERE,
      ...(filters?.restaurantId && { restaurantId: filters.restaurantId }),
      ...(filters?.isActive !== undefined && { isActive: filters.isActive }),
      // Par défaut, ne pas inclure les menus expirés
      ...(filters?.includeExpired ? {} : { dateFin: { gte: new Date() } }),
    };

    const [menus, total] = await Promise.all([
      this.prisma.menuDuJour.findMany({
        where,
        include: this.menuInclude('public'),
        orderBy: { dateDebut: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.menuDuJour.count({ where }),
    ]);

    return {
      message: 'Menus récupérés avec succès',
      data: menus,
      // `count` conservé : les trois clients le lisent (contrat inchangé).
      count: menus.length,
      meta: { page, limit, total, hasMore: page * limit < total },
    };
  }

  /**
   * Menus actifs du jour — même frontière marketplace et mêmes bornes.
   */
  async getActiveMenus(
    restaurantId?: string,
    page = 1,
    limit = MENUS_DEFAULT_LIMIT,
  ) {
    const now = new Date();
    const where: Prisma.MenuDuJourWhereInput = {
      restaurant: PUBLIC_VENDOR_WHERE,
      isActive: true,
      dateDebut: { lte: now },
      dateFin: { gte: now },
      ...(restaurantId && { restaurantId }),
    };

    const [menus, total] = await Promise.all([
      this.prisma.menuDuJour.findMany({
        where,
        include: this.menuInclude('public', now),
        orderBy: { dateDebut: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.menuDuJour.count({ where }),
    ]);

    return {
      message: 'Menus actifs récupérés avec succès',
      data: menus,
      count: menus.length,
      meta: { page, limit, total, hasMore: page * limit < total },
    };
  }

  /**
   * Menus d'un vendeur pour un ADMIN — **sans** frontière marketplace.
   *
   * `GET /menus` étant public et désormais filtré (SEC-02), l'administration
   * perdrait sinon la vue sur les vendeurs en cours d'onboarding : exactement
   * ceux dont il faut remplir le catalogue. Route distincte plutôt que dérogation
   * dans la route publique — une frontière de sécurité qui accepte des
   * exceptions n'en est plus une.
   */
  async findAllForAdmin(restaurantId: string) {
    const menus = await this.prisma.menuDuJour.findMany({
      where: { restaurantId },
      include: this.menuInclude('owner'),
      orderBy: { dateDebut: 'desc' },
    });

    return {
      message: 'Menus du vendeur récupérés avec succès',
      data: menus,
      count: menus.length,
    };
  }

  /**
   * Obtenir un menu par son ID
   */
  async findOne(id: string) {
    // Même frontière que les listes (fix SEC-02) : un menu ne doit pas rester
    // consultable par lien direct quand son vendeur ne l'est pas.
    const menu = await this.prisma.menuDuJour.findFirst({
      where: { id, restaurant: PUBLIC_VENDOR_WHERE },
      include: {
        products: {
          where: { product: availableProductWhere(this.prisma.product.fields) },
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
