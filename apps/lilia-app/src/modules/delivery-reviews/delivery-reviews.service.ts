import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { DeliveryStatus, Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { CreateDeliveryReviewDto } from './dto/create-delivery-review.dto';

/**
 * Notation du livreur par le client, après livraison.
 *
 * Modèle distinct de `Review` (qui note un vendeur) : `Review.orderId` est
 * `@unique`, donc y loger la note du livreur empêcherait de noter le restaurant
 * ET le livreur pour une même commande.
 *
 * Quatre règles, toutes appliquées ici **et** en base :
 *  - seul le client propriétaire de la commande peut noter ;
 *  - la livraison doit être effectivement `LIVRER` ;
 *  - une seule note par livraison (`@@unique([deliveryId])`) ;
 *  - la note porte sur le livreur qui a réellement fait la course.
 */
@Injectable()
export class DeliveryReviewsService {
  private readonly logger = new Logger(DeliveryReviewsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async create(dto: CreateDeliveryReviewDto, firebaseUid: string) {
    const user = await this.prisma.user.findUnique({ where: { firebaseUid } });
    if (!user) throw new NotFoundException('Utilisateur non trouvé.');

    const delivery = await this.prisma.delivery.findUnique({
      where: { id: dto.deliveryId },
      select: {
        id: true,
        status: true,
        orderId: true,
        delivererId: true,
        order: { select: { userId: true } },
      },
    });

    if (!delivery) throw new NotFoundException('Livraison introuvable.');

    // Un client ne note que SES livraisons. Sans ce contrôle, connaître un
    // deliveryId suffirait à noter la course d'un inconnu.
    if (delivery.order.userId !== user.id) {
      throw new ForbiddenException(
        'Vous ne pouvez noter que vos propres livraisons.',
      );
    }

    if (delivery.status !== DeliveryStatus.LIVRER) {
      throw new BadRequestException(
        'Vous pourrez noter le livreur une fois la commande livrée.',
      );
    }

    // Une livraison marquée LIVRER a forcément eu un livreur ; la garde couvre
    // les données antérieures aux clés étrangères.
    if (!delivery.delivererId) {
      throw new BadRequestException(
        'Aucun livreur n’est rattaché à cette livraison.',
      );
    }

    try {
      const review = await this.prisma.deliveryReview.create({
        data: {
          deliveryId: delivery.id,
          orderId: delivery.orderId,
          delivererId: delivery.delivererId,
          userId: user.id,
          rating: dto.rating,
          comment: dto.comment ?? null,
        },
      });

      this.logger.log(
        `⭐ Livreur ${delivery.delivererId} noté ${dto.rating}/5 sur la livraison ${delivery.id}`,
      );

      return { message: 'Merci pour votre note !', data: review };
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        // La contrainte d'unicité fait le travail même en cas de double-tap :
        // deux requêtes concurrentes ne peuvent pas créer deux notes.
        throw new ConflictException(
          'Vous avez déjà noté cette livraison. Merci !',
        );
      }
      throw error;
    }
  }

  /**
   * Note moyenne et distribution d'un livreur.
   *
   * `groupBy` plutôt que chargement complet : la moyenne d'un livreur actif
   * depuis six mois ne doit pas coûter le transfert de toutes ses notes.
   */
  async getDelivererStats(delivererId: string) {
    const grouped = await this.prisma.deliveryReview.groupBy({
      by: ['rating'],
      where: { delivererId },
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

    return {
      data: {
        delivererId,
        averageRating:
          totalReviews > 0
            ? Math.round((totalRating / totalReviews) * 10) / 10
            : null,
        totalReviews,
        ratingDistribution,
      },
    };
  }

  /**
   * Note existante pour une livraison — permet au client de savoir s'il a déjà
   * noté, et à l'app d'afficher sa note plutôt que le formulaire.
   */
  async findByDelivery(deliveryId: string, firebaseUid: string) {
    const user = await this.prisma.user.findUnique({ where: { firebaseUid } });
    if (!user) throw new NotFoundException('Utilisateur non trouvé.');

    const delivery = await this.prisma.delivery.findUnique({
      where: { id: deliveryId },
      select: {
        delivererId: true,
        order: { select: { userId: true } },
        review: true,
      },
    });
    if (!delivery) throw new NotFoundException('Livraison introuvable.');

    // Même périmètre que la création : le client concerné, ou le livreur noté.
    const isCustomer = delivery.order.userId === user.id;
    const isDeliverer = delivery.delivererId === user.id;
    if (!isCustomer && !isDeliverer && user.role !== 'ADMIN') {
      throw new ForbiddenException(
        'Vous n’êtes pas concerné par cette livraison.',
      );
    }

    return { data: delivery.review };
  }

  /** Historique des notes reçues par le livreur connecté. */
  async findMine(firebaseUid: string, page = 1, limit = 20) {
    const user = await this.prisma.user.findUnique({ where: { firebaseUid } });
    if (!user) throw new NotFoundException('Utilisateur non trouvé.');

    const where = { delivererId: user.id };
    const [reviews, total] = await Promise.all([
      this.prisma.deliveryReview.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        // Le livreur voit la note et le commentaire, pas l'identité du client :
        // une note doit pouvoir être honnête sans exposer son auteur.
        select: {
          id: true,
          rating: true,
          comment: true,
          createdAt: true,
          orderId: true,
        },
      }),
      this.prisma.deliveryReview.count({ where }),
    ]);

    return { data: reviews, meta: { page, limit, total } };
  }
}
