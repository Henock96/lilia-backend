/* eslint-disable prettier/prettier */
import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, ProductType, VendorType } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Lectures du catalogue produits (extrait de ProductsService — LIL-143).
 * Regroupe les requêtes de consultation : catalogue, détail, populaires,
 * recherche et recommandations.
 */
@Injectable()
export class ProductQueryService {
  constructor(private prisma: PrismaService) {}

  /**
   * Récupère les produits du catalogue marketplace (route publique).
   * Filtre toujours sur restaurant.isActive + adminApproved : on n'expose
   * jamais le catalogue d'un vendeur en attente de validation ou suspendu.
   */
  async findAll(
    restaurantId?: string,
    categoryId?: string,
    page = 1,
    limit = 20,
    productType?: ProductType,
    vendorType?: VendorType,
  ) {
    const where: Prisma.ProductWhereInput = {
      restaurant: {
        isActive: true,
        adminApproved: true,
        ...(vendorType && { vendorType }),
      },
      ...(restaurantId && { restaurantId }),
      ...(categoryId && { categoryId }),
      ...(productType && { productType }),
    };

    const [products, total] = await Promise.all([
      this.prisma.product.findMany({
        where,
        include: {
          category: true,
          variants: true,
          restaurant: {
            select: {
              id: true,
              nom: true,
              vendorType: true,
            },
          },
          images: { orderBy: [{ isCover: 'desc' }, { displayOrder: 'asc' }] },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.product.count({ where }),
    ]);

    return {
      data: products,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * Récupère un produit par son ID
   */
  async findOne(id: string) {
    const product = await this.prisma.product.findUnique({
      where: { id },
      include: {
        category: true,
        variants: true,
        restaurant: {
          select: {
            id: true,
            nom: true,
          },
        },
        images: { orderBy: [{ isCover: 'desc' }, { displayOrder: 'asc' }] },
      },
    });

    if (!product) {
      throw new NotFoundException(`Produit avec l'ID "${id}" non trouvé.`);
    }

    return {
      data: product,
    };
  }

  /**
   * Récupère les produits les plus commandés (plats populaires)
   */
  async findPopular(limit = 10) {
    // 1. Agréger le nombre de commandes par produit
    const popularProductIds = await this.prisma.orderItem.groupBy({
      by: ['productId'],
      _count: { productId: true },
      orderBy: { _count: { productId: 'desc' } },
      take: limit,
    });

    if (popularProductIds.length === 0) {
      return { data: [] };
    }

    const productIds = popularProductIds.map(p => p.productId);
    const countMap = Object.fromEntries(
      popularProductIds.map(p => [p.productId, p._count.productId]),
    );

    // 2. Récupérer les détails complets des produits
    const products = await this.prisma.product.findMany({
      where: {
        id: { in: productIds },
        restaurant: { isActive: true, adminApproved: true },
      },
      include: {
        category: true,
        variants: true,
        restaurant: {
          select: { id: true, nom: true, imageUrl: true, isOpen: true },
        },
        images: { orderBy: [{ isCover: 'desc' }, { displayOrder: 'asc' }] },
      },
    });

    // 3. Trier par nombre de commandes et attacher le compteur
    const sorted = productIds
      .map(id => products.find(p => p.id === id))
      .filter(Boolean)
      .map(p => ({ ...p, orderCount: countMap[p.id] || 0 }));

    return { data: sorted };
  }

  /**
   * Recherche de produits et restaurants par texte
   */
  async search(query: string, limit = 20) {
    const searchTerm = query.trim();
    if (!searchTerm) {
      return { restaurants: [], products: [] };
    }

    const [restaurants, products] = await Promise.all([
      this.prisma.restaurant.findMany({
        where: {
          isActive: true,
          OR: [
            { nom: { contains: searchTerm, mode: 'insensitive' } },
            { specialties: { some: { name: { contains: searchTerm, mode: 'insensitive' } } } },
          ],
        },
        include: {
          specialties: true,
          operatingHours: true,
          photos: { orderBy: [{ isCover: 'desc' }, { displayOrder: 'asc' }] },
        },
        take: limit,
      }),
      this.prisma.product.findMany({
        where: {
          OR: [
            { nom: { contains: searchTerm, mode: 'insensitive' } },
            { description: { contains: searchTerm, mode: 'insensitive' } },
            { category: { nom: { contains: searchTerm, mode: 'insensitive' } } },
          ],
          restaurant: { isActive: true, adminApproved: true },
        },
        include: {
          category: true,
          variants: true,
          restaurant: {
            select: { id: true, nom: true, imageUrl: true, isOpen: true },
          },
          images: { orderBy: [{ isCover: 'desc' }, { displayOrder: 'asc' }] },
        },
        take: limit,
      }),
    ]);

    return { restaurants, products };
  }

  /**
   * Recommandations basées sur l'historique de commandes de l'utilisateur
   */
  async getRecommendations(firebaseUid: string, limit = 10) {
    const user = await this.prisma.user.findUnique({ where: { firebaseUid } });
    if (!user) return { data: [] };

    // 1. Récupérer les catégories et restaurants des commandes précédentes
    const userOrderItems = await this.prisma.orderItem.findMany({
      where: { order: { userId: user.id } },
      select: {
        productId: true,
        product: { select: { categoryId: true, restaurantId: true } },
      },
      take: 100,
      orderBy: { createdAt: 'desc' },
    });

    if (userOrderItems.length === 0) {
      // Utilisateur sans historique → retourner les plats populaires
      return this.findPopular(limit);
    }

    const categoryIds = [...new Set(
      userOrderItems.map(oi => oi.product.categoryId).filter(Boolean),
    )] as string[];
    const restaurantIds = [...new Set(
      userOrderItems.map(oi => oi.product.restaurantId),
    )];
    const excludeIds = [...new Set(
      userOrderItems.map(oi => oi.productId),
    )];

    // 2. Trouver des produits similaires pas encore commandés
    const recommendations = await this.prisma.product.findMany({
      where: {
        id: { notIn: excludeIds },
        restaurant: { isActive: true, adminApproved: true },
        OR: [
          ...(categoryIds.length > 0 ? [{ categoryId: { in: categoryIds } }] : []),
          { restaurantId: { in: restaurantIds } },
        ],
      },
      include: {
        category: true,
        variants: true,
        restaurant: {
          select: { id: true, nom: true, imageUrl: true, isOpen: true },
        },
        images: { orderBy: [{ isCover: 'desc' }, { displayOrder: 'asc' }] },
      },
      take: limit,
      orderBy: { createdAt: 'desc' },
    });

    return { data: recommendations };
  }
}
