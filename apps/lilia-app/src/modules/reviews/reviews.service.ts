import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateReviewDto, UpdateReviewDto } from './dto';

@Injectable()
export class ReviewsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Créer un nouvel avis
   * Un utilisateur ne peut laisser qu'un seul avis par restaurant
   */
  async create(dto: CreateReviewDto, firebaseUid: string) {
    const user = await this.prisma.user.findUnique({ where: { firebaseUid } });
    if (!user) throw new NotFoundException('Utilisateur non trouvé');

    const restaurant = await this.prisma.restaurant.findUnique({
      where: { id: dto.restaurantId },
    });
    if (!restaurant) throw new NotFoundException('Restaurant non trouvé');

    // Vérifie que la commande existe, est livrée, et appartient au user
    if (dto.orderId) {
      const order = await this.prisma.order.findFirst({
        where: {
          id: dto.orderId,
          userId: user.id,
          restaurantId: dto.restaurantId,
          status: 'LIVRER',
        },
      });
      if (!order) {
        throw new BadRequestException(
          'Commande introuvable, non livrée, ou ne vous appartient pas.',
        );
      }

      // Vérifie qu'il n'y a pas déjà un avis pour cette commande
      const existingForOrder = await this.prisma.review.findUnique({
        where: { orderId: dto.orderId },
      });
      if (existingForOrder) {
        throw new ConflictException(
          'Vous avez déjà laissé un avis pour cette commande.',
        );
      }
    } else {
      // Sans orderId : vérifie qu'il a au moins une commande livrée dans ce restaurant
      const hasDelivered = await this.prisma.order.findFirst({
        where: {
          userId: user.id,
          restaurantId: dto.restaurantId,
          status: 'LIVRER',
        },
      });
      if (!hasDelivered) {
        throw new BadRequestException(
          'Vous devez avoir reçu au moins une commande de ce restaurant.',
        );
      }

      // La contrainte `@@unique([userId, restaurantId])` a été retirée (audit
      // du 28/08/2026) : elle interdisait un deuxième avis chez le même
      // vendeur, ce qui contredisait le flux « un avis par commande livrée ».
      // L'anti-spam reste nécessaire pour les avis SANS commande rattachée :
      // un seul par client et par vendeur.
      const existingFreeReview = await this.prisma.review.findFirst({
        where: {
          userId: user.id,
          restaurantId: dto.restaurantId,
          orderId: null,
        },
      });
      if (existingFreeReview) {
        throw new ConflictException(
          'Vous avez déjà laissé un avis général pour ce vendeur. ' +
            'Pour en laisser un nouveau, rattachez-le à une commande livrée.',
        );
      }
    }

    const review = await this.prisma.review.create({
      data: {
        rating: dto.rating,
        comment: dto.comment,
        userId: user.id,
        restaurantId: dto.restaurantId,
        orderId: dto.orderId ?? null,
      },
      include: {
        user: { select: { id: true, nom: true, imageUrl: true } },
        restaurant: { select: { id: true, nom: true } },
      },
    });

    return { message: 'Avis créé avec succès', data: review };
  }

  /**
   * Récupérer tous les avis d'un restaurant
   */
  /**
   * Avis d'un vendeur, paginés.
   *
   * La route est publique : sans `take`, un vendeur populaire renvoyait
   * l'intégralité de ses avis à chaque ouverture de fiche.
   */
  async findByRestaurant(restaurantId: string, page = 1, limit = 20) {
    const restaurant = await this.prisma.restaurant.findUnique({
      where: { id: restaurantId },
    });

    if (!restaurant) {
      throw new NotFoundException('Restaurant non trouvé');
    }

    const [reviews, total] = await Promise.all([
      this.prisma.review.findMany({
        where: { restaurantId },
        include: {
          user: {
            select: {
              id: true,
              nom: true,
              imageUrl: true,
            },
          },
        },
        orderBy: {
          createdAt: 'desc',
        },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.review.count({ where: { restaurantId } }),
    ]);

    // Calculer les statistiques
    const stats = await this.getRestaurantStats(restaurantId);

    return {
      message: 'Avis récupérés avec succès',
      data: reviews,
      stats,
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  /**
   * Récupérer les statistiques d'un restaurant
   */
  async getRestaurantStats(restaurantId: string) {
    // PERFORMANCE (fix P0, audit du 28/08/2026) : la méthode chargeait **tous**
    // les avis du vendeur en mémoire pour calculer une moyenne et un
    // histogramme. À 10 000 avis, c'est 10 000 lignes transférées à chaque
    // affichage de fiche vendeur — sur une route publique, donc un
    // amplificateur de charge gratuit. `groupBy` fait le travail côté
    // PostgreSQL, avec l'index (restaurantId, rating).
    const grouped = await this.prisma.review.groupBy({
      by: ['rating'],
      where: { restaurantId },
      _count: { rating: true },
    });

    const ratingDistribution: Record<1 | 2 | 3 | 4 | 5, number> = {
      1: 0,
      2: 0,
      3: 0,
      4: 0,
      5: 0,
    };

    let totalReviews = 0;
    let totalRating = 0;

    for (const row of grouped) {
      const count = row._count.rating;
      totalReviews += count;
      totalRating += row.rating * count;
      if (row.rating >= 1 && row.rating <= 5) {
        ratingDistribution[row.rating as 1 | 2 | 3 | 4 | 5] = count;
      }
    }

    if (totalReviews === 0) {
      return { averageRating: 0, totalReviews: 0, ratingDistribution };
    }

    return {
      averageRating: Math.round((totalRating / totalReviews) * 10) / 10, // 1 décimale
      totalReviews,
      ratingDistribution,
    };
  }

  /**
   * Récupérer un avis par son ID
   */
  async findOne(id: string) {
    const review = await this.prisma.review.findUnique({
      where: { id },
      include: {
        user: {
          select: {
            id: true,
            nom: true,
            imageUrl: true,
          },
        },
        restaurant: {
          select: {
            id: true,
            nom: true,
          },
        },
      },
    });

    if (!review) {
      throw new NotFoundException('Avis non trouvé');
    }

    return {
      message: 'Avis récupéré avec succès',
      data: review,
    };
  }

  /**
   * Mettre à jour un avis
   * Seul l'auteur de l'avis peut le modifier
   */
  async update(id: string, dto: UpdateReviewDto, firebaseUid: string) {
    const user = await this.prisma.user.findUnique({
      where: { firebaseUid },
    });

    if (!user) {
      throw new NotFoundException('Utilisateur non trouvé');
    }

    const review = await this.prisma.review.findUnique({
      where: { id },
    });

    if (!review) {
      throw new NotFoundException('Avis non trouvé');
    }

    if (review.userId !== user.id) {
      throw new ForbiddenException(
        'Vous ne pouvez modifier que vos propres avis',
      );
    }

    const updatedReview = await this.prisma.review.update({
      where: { id },
      data: {
        rating: dto.rating,
        comment: dto.comment,
      },
      include: {
        user: {
          select: {
            id: true,
            nom: true,
            imageUrl: true,
          },
        },
      },
    });

    return {
      message: 'Avis mis à jour avec succès',
      data: updatedReview,
    };
  }

  /**
   * Supprimer un avis
   * Seul l'auteur ou un admin peut supprimer un avis
   */
  async remove(id: string, firebaseUid: string) {
    const user = await this.prisma.user.findUnique({
      where: { firebaseUid },
    });

    if (!user) {
      throw new NotFoundException('Utilisateur non trouvé');
    }

    const review = await this.prisma.review.findUnique({
      where: { id },
    });

    if (!review) {
      throw new NotFoundException('Avis non trouvé');
    }

    // Vérifier si l'utilisateur est l'auteur ou un admin
    if (review.userId !== user.id && user.role !== 'ADMIN') {
      throw new ForbiddenException(
        'Vous ne pouvez supprimer que vos propres avis',
      );
    }

    await this.prisma.review.delete({
      where: { id },
    });

    return {
      message: 'Avis supprimé avec succès',
    };
  }

  /**
   * Récupérer l'avis de l'utilisateur connecté pour un restaurant
   */
  async getUserReview(restaurantId: string, firebaseUid: string) {
    const user = await this.prisma.user.findUnique({
      where: { firebaseUid },
    });

    if (!user) {
      throw new NotFoundException('Utilisateur non trouvé');
    }

    // La contrainte `@@unique([userId, restaurantId])` a été retirée (audit du
    // 28/08/2026) : un client peut désormais laisser un avis par commande
    // livrée. On renvoie le plus récent.
    const review = await this.prisma.review.findFirst({
      where: { userId: user.id, restaurantId },
      orderBy: { createdAt: 'desc' },
      include: {
        user: {
          select: {
            id: true,
            nom: true,
            imageUrl: true,
          },
        },
      },
    });

    return {
      message: review ? 'Avis trouvé' : 'Aucun avis trouvé',
      data: review,
    };
  }

  /**
   * Vérifier si l'utilisateur peut laisser un avis (a commandé dans le restaurant)
   */
  async canReview(restaurantId: string, firebaseUid: string) {
    const user = await this.prisma.user.findUnique({
      where: { firebaseUid },
    });

    if (!user) {
      return { canReview: false, reason: 'Utilisateur non trouvé' };
    }

    // Depuis le retrait de `@@unique([userId, restaurantId])` (audit du
    // 28/08/2026), un client peut laisser un avis par commande livrée. Seul
    // l'avis « général » (sans commande rattachée) reste unique.
    const existingFreeReview = await this.prisma.review.findFirst({
      where: { userId: user.id, restaurantId, orderId: null },
    });

    if (existingFreeReview) {
      return {
        canReview: false,
        reason: 'Vous avez déjà laissé un avis général pour ce vendeur',
        existingReviewId: existingFreeReview.id,
      };
    }

    // Vérifier si l'utilisateur a commandé dans ce restaurant
    const hasOrdered = await this.prisma.order.findFirst({
      where: {
        userId: user.id,
        restaurantId,
        status: 'LIVRER',
      },
    });

    if (!hasOrdered) {
      return {
        canReview: false,
        reason: 'Vous devez avoir commandé dans ce restaurant',
      };
    }

    return { canReview: true };
  }
}
