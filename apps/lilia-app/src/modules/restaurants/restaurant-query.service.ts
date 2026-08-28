/* eslint-disable prettier/prettier */
import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  PHOTOS_GALLERY,
  RESTAURANT_INCLUDE,
  RESTAURANT_WITH_REVIEWS,
} from './restaurant.includes';

/**
 * Lectures, scoring et analytics restaurants (extrait de RestaurantsService —
 * LIL-145). Regroupe les requêtes de consultation (catalogue, détail, mon
 * restaurant, populaires) et les analytics côté restaurateur (commandes,
 * clients).
 */
@Injectable()
export class RestaurantQueryService {
  /** Nombre de produits renvoyés dans le détail d'un vendeur. */
  private static readonly PRODUCTS_PREVIEW_LIMIT = 100;

  constructor(private prisma: PrismaService) {}

  // ─── LECTURE ───────────────────────────────────────────────────────────────

  async findAll() {
    const restaurants = await this.prisma.restaurant.findMany({
      where: { isActive: true, adminApproved: true },
      include: RESTAURANT_INCLUDE,
      orderBy: { createdAt: 'desc' },
    });
    return { data: restaurants };
  }

  /**
   * Détail public d'un vendeur.
   *
   * Le filtre `isActive + adminApproved` est le même que sur la liste : sans
   * lui, un vendeur suspendu ou en attente de validation restait publiquement
   * consultable par lien direct, catalogue complet inclus. Aligné sur
   * `VendorsService.findOne`.
   *
   * Les produits sont bornés : `findOne` chargeait *tous* les produits avec
   * toutes leurs variantes et images. Pour une épicerie de 400 références,
   * c'était plusieurs mégaoctets sur la 4G de Brazzaville. Au-delà de
   * `PRODUCTS_PREVIEW_LIMIT`, le client pagine via `GET /products?restaurantId=`.
   */
  async findOne(id: string) {
    const restaurant = await this.prisma.restaurant.findFirst({
      where: { id, isActive: true, adminApproved: true },
      include: {
        products: {
          include: {
            category: true,
            variants: true,
            images: { orderBy: [{ isCover: 'desc' }, { displayOrder: 'asc' }] },
          },
          orderBy: { createdAt: 'desc' },
          take: RestaurantQueryService.PRODUCTS_PREVIEW_LIMIT,
        },
        _count: { select: { products: true } },
        ...RESTAURANT_WITH_REVIEWS,
      },
    });

    if (!restaurant) {
      throw new NotFoundException(`Restaurant "${id}" non trouvé.`);
    }

    const { _count, ...rest } = restaurant;
    return {
      data: {
        ...this.attachRatingStats(rest),
        totalProducts: _count.products,
        hasMoreProducts:
          _count.products > RestaurantQueryService.PRODUCTS_PREVIEW_LIMIT,
      },
    };
  }

  /**
   * Restaurant du propriétaire connecté.
   * Un user ne peut avoir qu'un seul restaurant — findFirst suffit.
   */
  async findMyRestaurant(firebaseUid: string) {
    const restaurant = await this.prisma.restaurant.findFirst({
      where: { owner: { firebaseUid } },
      include: {
        ...RESTAURANT_INCLUDE,
        _count: { select: { orders: true, products: true } },
      },
    });

    if (!restaurant) {
      throw new NotFoundException('Aucun restaurant trouvé pour ce compte.');
    }

    return { data: restaurant };
  }

  /**
   * Restaurants populaires triés par nombre de commandes.
   * On évite de recalculer avgRating en DB pour garder la query légère.
   */
  async findPopular(limit = 6) {
    const topIds = await this.prisma.order.groupBy({
      by: ['restaurantId'],
      _count: { restaurantId: true },
      orderBy: { _count: { restaurantId: 'desc' } },
      take: limit,
    });

    if (topIds.length === 0) return { data: [] };

    const ids = topIds.map((r) => r.restaurantId);
    const countMap = new Map(topIds.map((r) => [r.restaurantId, r._count.restaurantId]));

    const restaurants = await this.prisma.restaurant.findMany({
      where: { id: { in: ids }, isActive: true, adminApproved: true },
      include: RESTAURANT_WITH_REVIEWS,
    });

    // Préserve le tri par popularité
    const sorted = ids
      .map((id) => restaurants.find((r) => r.id === id))
      .filter(Boolean)
      .map((r) => ({
        ...this.attachRatingStats(r),
        orderCount: countMap.get(r.id) ?? 0,
      }));

    return { data: sorted };
  }

  async findRestaurant() {
    const resto = await this.prisma.restaurant.findMany({
      where: { isActive: true, adminApproved: true },
      include: {
        specialties: true,
        operatingHours: true,
        photos: PHOTOS_GALLERY,
      },
      orderBy: { createdAt: 'desc' },
    });
    return {
      data: resto,
      message: 'Restaurant récupéré avec succès'
    }
  }

  // ─── ANALYTICS RESTAURANT ─────────────────────────────────────────────────

  /**
   * Nombre total de commandes du restaurant.
   * Fix : prisma.order.count() ne prend pas de select.
   */
  async countOrders(restaurantId: string) {
    const count = await this.prisma.order.count({ where: { restaurantId } });
    return { data: { count }, message: 'Nombre de commandes du restaurant' };
  }

  /**
   * Liste paginée des clients distincts du restaurant.
   * Fix : la pagination s'applique sur les userIds dédupliqués,
   * pas sur les orders brutes (qui peuvent être en milliers).
   */
  async findClients(page = 1, limit = 10, restaurantId: string) {
    const grouped = await this.prisma.order.groupBy({
      by: ['userId'],
      where: { restaurantId },
    });

    if (grouped.length === 0) return { data: [], total: 0 };

    const userIds = grouped.map((g) => g.userId);

    const [clients, total] = await Promise.all([
      this.prisma.user.findMany({
        where: { id: { in: userIds } },
        select: {
          id: true,
          email: true,
          nom: true,
          phone: true,
          imageUrl: true,
          role: true,
          createdAt: true,
        },
        skip: (page - 1) * limit,
        take: limit,
      }),
      Promise.resolve(userIds.length), // total déjà calculé via groupBy
    ]);

    return { data: clients, total, page, limit };
  }

  async findClientWithOrders(restaurantId: string, userId: string) {
    const orders = await this.prisma.order.findMany({
      where: {
        restaurantId,
        userId,
      },
      orderBy: { createdAt: 'desc' },
      // Optionnel : inclure les détails des produits/plats de la commande
      include: {
        items: {
          include: {
            product: true,
          },
        },
      },
    });

    return {
      data: orders,
      message: "Commandes du client pour ce restaurant"
    };
  }

  /**
   * Calcule et attache les stats de notation sur un restaurant.
   * Extracted pour éviter la duplication dans findOne et findPopular.
   */
  private attachRatingStats<T extends { reviews: { rating: number }[] }>(restaurant: T) {
    const { reviews, ...rest } = restaurant;
    const avgRating =
      reviews.length > 0
        ? reviews.reduce((sum, r) => sum + r.rating, 0) / reviews.length
        : null;

    return {
      ...rest,
      averageRating: avgRating !== null ? Math.round(avgRating * 10) / 10 : null,
      totalReviews: reviews.length,
    };
  }
}
