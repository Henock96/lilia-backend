/* eslint-disable prettier/prettier */
import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  PUBLIC_VENDOR_ORDER_BY,
  PUBLIC_VENDOR_WHERE,
} from '../../common/vendor-visibility';
import {
  MENU_PRODUCTS_LIMIT,
  vendorMenuInclude,
  withAvailableNow,
} from '../products/vendor-menu.include';
import {
  PHOTOS_GALLERY,
  RESTAURANT_INCLUDE,
  RESTAURANT_LIST_INCLUDE,
} from './restaurant.includes';
import { aggregateRatings, NO_RATING } from './restaurant-ratings';

/**
 * Lectures, scoring et analytics restaurants (extrait de RestaurantsService —
 * LIL-145). Regroupe les requêtes de consultation (catalogue, détail, mon
 * restaurant, populaires) et les analytics côté restaurateur (commandes,
 * clients).
 */
@Injectable()
export class RestaurantQueryService {
  // ⚠️ `PRODUCTS_PREVIEW_LIMIT` a disparu : la borne du menu est désormais
  // `MENU_PRODUCTS_LIMIT`, partagée avec `GET /vendors/:id`. Deux constantes
  // pour une même notion, c'est la définition même de la divergence qu'on
  // vient de supprimer.

  /** Taille de page par défaut du catalogue vendeurs. */
  private static readonly LIST_DEFAULT_LIMIT = 50;

  constructor(private prisma: PrismaService) {}

  // ─── LECTURE ───────────────────────────────────────────────────────────────

  /**
   * Catalogue public des vendeurs — **paginé** (fix P0).
   *
   * La méthode retournait tous les vendeurs actifs avec leurs spécialités,
   * horaires et galerie complète, sans aucune borne. Le défaut de 50 couvre
   * largement l'usage réel (une page d'accueil), et `meta.total` permet au
   * client de savoir s'il doit continuer.
   */
  async findAll(page = 1, limit = RestaurantQueryService.LIST_DEFAULT_LIMIT) {
    const [restaurants, total] = await Promise.all([
      this.prisma.restaurant.findMany({
        where: PUBLIC_VENDOR_WHERE,
        include: RESTAURANT_LIST_INCLUDE,
        // Ordre partagé avec `GET /vendors` (cf. PUBLIC_VENDOR_ORDER_BY) : les
        // deux routes listent la même entité et divergeaient jusqu'ici.
        orderBy: [...PUBLIC_VENDOR_ORDER_BY],
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.restaurant.count({
        where: PUBLIC_VENDOR_WHERE,
      }),
    ]);

    return {
      data: restaurants,
      meta: {
        page,
        limit,
        total,
        hasMore: page * limit < total,
      },
    };
  }

  /**
   * Détail public d'un vendeur — **réglages + carte**.
   *
   * ⚠️ Cette route n'est plus la source canonique du menu : `GET /vendors/:id`
   * l'est. Elle la conserve néanmoins, pour deux raisons qui n'ont rien à voir
   * avec le catalogue — `apps/web/panier` (frais de livraison, minimum de
   * commande, `isOpen`) et `apps/admin/mon-restaurant` (réglages) l'appellent
   * et lisent la réponse entière. La supprimer, ou en retirer `products`,
   * casserait un contrat que rien ne type.
   *
   * Ce qui change : le bloc catalogue vient désormais de `vendorMenuInclude`,
   * **exactement le même** que celui de `VendorsService.findOne`. Les deux
   * routes ne peuvent donc plus diverger sur les produits épuisés, l'ordre, la
   * borne, les variantes, les images ou les menus du jour — elles l'avaient
   * fait sur six points, sans que rien ne le signale.
   * `vendor-menu-parity.spec.ts` compare les arguments Prisma des deux.
   */
  async findOne(id: string) {
    const now = new Date();

    const restaurant = await this.prisma.restaurant.findFirst({
      where: { id, ...PUBLIC_VENDOR_WHERE },
      include: {
        ...vendorMenuInclude(this.prisma.product.fields, now),
        ...RESTAURANT_INCLUDE,
      },
    });

    if (!restaurant) {
      throw new NotFoundException(`Restaurant "${id}" non trouvé.`);
    }

    const { _count, products, ...rest } = restaurant;
    const ratings = await aggregateRatings(this.prisma, [id]);

    return {
      data: {
        ...rest,
        products: withAvailableNow(products, now),
        ...(ratings.get(id) ?? NO_RATING),
        totalProducts: _count.products,
        hasMoreProducts: _count.products > MENU_PRODUCTS_LIMIT,
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
      where: { id: { in: ids }, ...PUBLIC_VENDOR_WHERE },
      include: RESTAURANT_LIST_INCLUDE,
    });

    const ratings = await aggregateRatings(this.prisma, restaurants.map((r) => r.id));

    // Préserve le tri par popularité
    const sorted = ids
      .map((id) => restaurants.find((r) => r.id === id))
      .filter(Boolean)
      .map((r) => ({
        ...r,
        ...(ratings.get(r.id) ?? { averageRating: null, totalReviews: 0 }),
        orderCount: countMap.get(r.id) ?? 0,
      }));

    return { data: sorted };
  }

  async findRestaurant() {
    const resto = await this.prisma.restaurant.findMany({
      where: PUBLIC_VENDOR_WHERE,
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
        // Minimisation des données (fix C1) : le vendeur n'a pas besoin de
        // l'e-mail de ses clients pour livrer — le téléphone suffit.
        select: {
          id: true,
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

}
