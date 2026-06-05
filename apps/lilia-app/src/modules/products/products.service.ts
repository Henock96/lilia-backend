/* eslint-disable prettier/prettier */
import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, ProductType, VendorType } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { PaginationService } from '../../common/pagination/pagination.service';
import { ProductValidatorService } from './product-validator.service';

@Injectable()
export class ProductsService {
  constructor(
    private prisma: PrismaService,
    private readonly paginationService: PaginationService,
    private readonly productValidator: ProductValidatorService,
  ) {}

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
   * Met à jour un produit
   */
  async update(id: string, dto: UpdateProductDto, firebaseUid: string) {
    // Vérifier que le produit existe et appartient au restaurant de l'utilisateur
    const product = await this.prisma.product.findUnique({
      where: { id },
      include: {
        restaurant: {
          include: { owner: true },
        },
      },
    });

    if (!product) {
      throw new NotFoundException(`Produit avec l'ID "${id}" non trouvé.`);
    }

    const actorUpdate = await this.prisma.user.findUnique({ where: { firebaseUid } });
    if (actorUpdate?.role !== 'ADMIN' && product.restaurant.owner.firebaseUid !== firebaseUid) {
      throw new ForbiddenException('Vous n\'êtes pas autorisé à modifier ce produit.');
    }

    // Vérifier la catégorie si fournie
    if (dto.categoryId) {
      const categoryExists = await this.prisma.category.findUnique({
        where: { id: dto.categoryId },
      });
      if (!categoryExists) {
        throw new NotFoundException("La catégorie spécifiée n'existe pas.");
      }
    }

    // Multi-vendeurs : si changement de productType, revalider la compat.
    if (dto.productType && dto.productType !== product.productType) {
      this.productValidator.assertProductTypeAllowed(
        product.restaurant.vendorType,
        dto.productType,
      );
    }
    // Si une seule borne horaire est touchée, valider la fenêtre finale.
    if (dto.availableFrom !== undefined || dto.availableUntil !== undefined) {
      this.productValidator.assertAvailabilityWindow(
        dto.availableFrom ?? product.availableFrom ?? undefined,
        dto.availableUntil ?? product.availableUntil ?? undefined,
      );
    }

    const { variants, ...productData } = dto;

    const updatedProduct = await this.prisma.$transaction(async (tx) => {
      // 1. Mettre à jour le produit
      const updated = await tx.product.update({
        where: { id },
        data: productData,
      });

      // 2. Gérer les variantes si fournies
      if (variants !== undefined) {
        // Récupérer les IDs des anciennes variantes
        const oldVariants = await tx.productVariant.findMany({
          where: { productId: id },
          select: { id: true },
        });
        const oldVariantIds = oldVariants.map((v) => v.id);

        // Supprimer d'abord les CartItems qui référencent ces variantes
        if (oldVariantIds.length > 0) {
          await tx.cartItem.deleteMany({
            where: { variantId: { in: oldVariantIds } },
          });
        }

        // Supprimer les anciennes variantes
        await tx.productVariant.deleteMany({
          where: { productId: id },
        });

        // Créer les nouvelles variantes
        if (variants.length > 0) {
          await tx.productVariant.createMany({
            data: variants.map((v) => ({
              label: v.label,
              prix: v.prix,
              productId: id,
            })),
          });
        } else {
          // Si aucune variante fournie, créer une variante par défaut
          await tx.productVariant.create({
            data: {
              label: 'Standard',
              prix: updated.prixOriginal,
              productId: id,
            },
          });
        }
      }

      // 3. Retourner le produit complet avec ses variantes
      return tx.product.findUnique({
        where: { id },
        include: {
          category: true,
          variants: true,
        },
      });
    });

    return {
      message: 'Produit mis à jour avec succès',
      data: updatedProduct,
    };
  }

  /**
   * Supprime un produit
   */
  async remove(id: string, firebaseUid: string) {
    // Vérifier que le produit existe et appartient au restaurant de l'utilisateur
    const product = await this.prisma.product.findUnique({
      where: { id },
      include: {
        restaurant: {
          include: { owner: true },
        },
      },
    });

    if (!product) {
      throw new NotFoundException(`Produit avec l'ID "${id}" non trouvé.`);
    }

    const actorRemove = await this.prisma.user.findUnique({ where: { firebaseUid } });
    if (actorRemove?.role !== 'ADMIN' && product.restaurant.owner.firebaseUid !== firebaseUid) {
      throw new ForbiddenException('Vous n\'êtes pas autorisé à supprimer ce produit.');
    }

    // Supprimer les variantes et le produit dans une transaction
    await this.prisma.$transaction(async (tx) => {
      // Récupérer les IDs des variantes
      const variants = await tx.productVariant.findMany({
        where: { productId: id },
        select: { id: true },
      });
      const variantIds = variants.map((v) => v.id);

      // Supprimer les CartItems qui référencent ces variantes
      if (variantIds.length > 0) {
        await tx.cartItem.deleteMany({
          where: { variantId: { in: variantIds } },
        });
      }

      // Supprimer les variantes
      await tx.productVariant.deleteMany({
        where: { productId: id },
      });

      // Supprimer les références dans les menus
      await tx.menuProduct.deleteMany({
        where: { productId: id },
      });

      // Supprimer le produit
      await tx.product.delete({
        where: { id },
      });
    });

    return {
      message: 'Produit supprimé avec succès',
    };
  }

  /**
   * Met à jour le stock d'un produit
   */
  async updateStock(productId: string, stockQuotidien: number | null, firebaseUid: string) {
    const product = await this.prisma.product.findUnique({
      where: { id: productId },
      include: { restaurant: { include: { owner: true } } },
    });

    if (!product) {
      throw new NotFoundException(`Produit avec l'ID "${productId}" non trouvé.`);
    }

    const user = await this.prisma.user.findUnique({ where: { firebaseUid } });
    if (!user) throw new NotFoundException('Utilisateur non trouvé.');

    if (user.role !== 'ADMIN' && product.restaurant.owner.firebaseUid !== firebaseUid) {
      throw new ForbiddenException('Vous n\'êtes pas autorisé à modifier le stock de ce produit.');
    }

    const updated = await this.prisma.product.update({
      where: { id: productId },
      data: {
        stockQuotidien: stockQuotidien,
        stockRestant: stockQuotidien,
      },
    });

    return {
      message: 'Stock mis à jour avec succès',
      data: updated,
    };
  }

  async create(dto: CreateProductDto, firebaseUid: string) {
    const restaurant = await this.prisma.restaurant.findFirst({
      where: {
        owner: {
          firebaseUid: firebaseUid,
        },
      },
    });

    if (!restaurant) {
      throw new ForbiddenException(
        'Vous devez posséder un restaurant pour créer un produit.',
      );
    }

    if (dto.categoryId) {
      const categoryExists = await this.prisma.category.findUnique({
        where: { id: dto.categoryId },
      });
      if (!categoryExists) {
        throw new NotFoundException("La catégorie spécifiée n'existe pas.");
      }
    }

    // Multi-vendeurs : valider que le vendorType accepte ce productType.
    // FOOD est le défaut historique et reste compatible avec RESTAURANT.
    const productType = dto.productType ?? ProductType.FOOD;
    this.productValidator.assertProductTypeAllowed(
      restaurant.vendorType,
      productType,
    );
    this.productValidator.assertAvailabilityWindow(
      dto.availableFrom,
      dto.availableUntil,
    );

    const produit = await this.prisma.$transaction(async (tx) => {
      // 1. Créer le produit de base
      const product = await tx.product.create({
        data: {
          nom: dto.nom,
          description: dto.description,
          imageUrl: dto.imageUrl,
          prixOriginal: dto.prixOriginal,
          restaurantId: restaurant.id,
          categoryId: dto.categoryId,
          productType,
          stockMode: dto.stockMode,
          stockQuotidien: dto.stockQuotidien,
          stockRestant: dto.stockQuotidien,
          ingredients: dto.ingredients,
          shelfLifeDays: dto.shelfLifeDays,
          madeToOrder: dto.madeToOrder ?? false,
          availableFrom: dto.availableFrom,
          availableUntil: dto.availableUntil,
        },
      });

      // 2. Gérer les variantes
      const variantsToCreate =
        dto.variants && dto.variants.length > 0
          ? dto.variants.map((v) => ({ ...v, productId: product.id }))
          : [
              {
                label: 'Standard',
                prix: dto.prixOriginal,
                productId: product.id,
              },
            ];

      await tx.productVariant.createMany({
        data: variantsToCreate,
      });

      // 3. Retourner le produit complet avec ses variantes
      return tx.product.findUnique({
        where: { id: product.id },
        include: {
          variants: true,
        },
      });
    });
    return {
      message: 'Création de produit réussie',
      data: produit,
    }
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
