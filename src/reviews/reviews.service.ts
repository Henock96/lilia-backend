import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateReviewDto, UpdateReviewDto } from './dto';

@Injectable()
export class ReviewsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Créer un nouvel avis
   * Un utilisateur ne peut laisser qu'un seul avis par restaurant
   */
  async create(dto: CreateReviewDto, firebaseUid: string) {
    // Vérifier que l'utilisateur existe
    const user = await this.prisma.user.findUnique({
      where: { firebaseUid },
    });

    if (!user) {
      throw new NotFoundException('Utilisateur non trouvé');
    }

    // Vérifier que le restaurant existe
    const restaurant = await this.prisma.restaurant.findUnique({
      where: { id: dto.restaurantId },
    });

    if (!restaurant) {
      throw new NotFoundException('Restaurant non trouvé');
    }

    // Vérifier si l'utilisateur a déjà laissé un avis pour ce restaurant
    const existingReview = await this.prisma.review.findUnique({
      where: {
        userId_restaurantId: {
          userId: user.id,
          restaurantId: dto.restaurantId,
        },
      },
    });

    if (existingReview) {
      throw new ConflictException(
        'Vous avez déjà laissé un avis pour ce restaurant. Vous pouvez le modifier.',
      );
    }

    // Optionnel: Vérifier que l'utilisateur a commandé dans ce restaurant
    const hasOrdered = await this.prisma.order.findFirst({
      where: {
        userId: user.id,
        restaurantId: dto.restaurantId,
        status: 'LIVRER', // Seulement les commandes livrées
      },
    });

    if (!hasOrdered) {
      throw new BadRequestException(
        'Vous devez avoir commandé et reçu une commande de ce restaurant pour laisser un avis.',
      );
    }

    // Créer l'avis
    const review = await this.prisma.review.create({
      data: {
        rating: dto.rating,
        comment: dto.comment,
        userId: user.id,
        restaurantId: dto.restaurantId,
        orderId: dto.orderId,
      },
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

    return {
      message: 'Avis créé avec succès',
      data: review,
    };
  }

  /**
   * Récupérer tous les avis d'un restaurant
   */
  async findByRestaurant(restaurantId: string) {
    const restaurant = await this.prisma.restaurant.findUnique({
      where: { id: restaurantId },
    });

    if (!restaurant) {
      throw new NotFoundException('Restaurant non trouvé');
    }

    const reviews = await this.prisma.review.findMany({
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
    });

    // Calculer les statistiques
    const stats = await this.getRestaurantStats(restaurantId);

    return {
      message: 'Avis récupérés avec succès',
      data: reviews,
      stats,
    };
  }

  /**
   * Récupérer les statistiques d'un restaurant
   */
  async getRestaurantStats(restaurantId: string) {
    const reviews = await this.prisma.review.findMany({
      where: { restaurantId },
      select: { rating: true },
    });

    if (reviews.length === 0) {
      return {
        averageRating: 0,
        totalReviews: 0,
        ratingDistribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
      };
    }

    const totalRating = reviews.reduce((sum, r) => sum + r.rating, 0);
    const averageRating = totalRating / reviews.length;

    // Distribution des notes
    const ratingDistribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    reviews.forEach((r) => {
      ratingDistribution[r.rating]++;
    });

    return {
      averageRating: Math.round(averageRating * 10) / 10, // Arrondi à 1 décimale
      totalReviews: reviews.length,
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
      throw new ForbiddenException('Vous ne pouvez modifier que vos propres avis');
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
      throw new ForbiddenException('Vous ne pouvez supprimer que vos propres avis');
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

    const review = await this.prisma.review.findUnique({
      where: {
        userId_restaurantId: {
          userId: user.id,
          restaurantId,
        },
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

    // Vérifier si l'utilisateur a déjà laissé un avis
    const existingReview = await this.prisma.review.findUnique({
      where: {
        userId_restaurantId: {
          userId: user.id,
          restaurantId,
        },
      },
    });

    if (existingReview) {
      return {
        canReview: false,
        reason: 'Vous avez déjà laissé un avis',
        existingReviewId: existingReview.id,
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
