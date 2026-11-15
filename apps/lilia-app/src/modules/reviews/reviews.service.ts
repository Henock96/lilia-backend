import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { PUBLIC_VENDOR_WHERE } from '../../common/vendor-visibility';
import { accessibleShopIds, canAccessShop } from '../vendors/shop-access';
import { CreateReviewDto, UpdateReviewDto } from './dto';
import {
  PUBLIC_REVIEW_SELECT,
  VISIBLE_REVIEW_WHERE,
  toPublicReview,
} from './review-public-projection';
import { REVIEWABLE_ORDER_WHERE } from './review-eligibility';

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
          // Lot B (D4.a) : remise prouvée seulement. Une clôture admin ou une
          // remise déclarée par le vendeur seul n'ouvrent pas d'avis.
          ...REVIEWABLE_ORDER_WHERE,
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
          ...REVIEWABLE_ORDER_WHERE,
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

    const review = await this.prisma.review
      .create({
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
      })
      .catch((error: unknown) => {
        // Double envoi : `orderId @unique` tranche, la seconde requête perd.
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2002'
        ) {
          throw new ConflictException(
            'Vous avez déjà laissé un avis pour cette commande.',
          );
        }
        throw error;
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
  /**
   * Route PUBLIQUE. Le filtre de visibilité manquait : les avis d'un vendeur
   * non publié ou suspendu restaient lisibles par lien direct — avec le `nom`
   * et la photo de profil des clients qui les avaient laissés.
   */
  async findByRestaurant(restaurantId: string, page = 1, limit = 20) {
    const restaurant = await this.prisma.restaurant.findFirst({
      where: { id: restaurantId, ...PUBLIC_VENDOR_WHERE },
    });

    if (!restaurant) {
      throw new NotFoundException('Restaurant non trouvé');
    }

    const [reviews, total] = await Promise.all([
      this.prisma.review.findMany({
        where: { restaurantId, ...VISIBLE_REVIEW_WHERE },
        // F-30 — route publique : liste blanche, jamais `include:`.
        select: PUBLIC_REVIEW_SELECT,
        orderBy: {
          createdAt: 'desc',
        },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.review.count({
        where: { restaurantId, ...VISIBLE_REVIEW_WHERE },
      }),
    ]);

    // Calculer les statistiques
    const stats = await this.getRestaurantStats(restaurantId);

    return {
      message: 'Avis récupérés avec succès',
      data: reviews.map(toPublicReview),
      stats,
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  /**
   * Récupérer les statistiques d'un restaurant
   */
  /**
   * @param assertVisible contrôle la frontière de visibilité publique. Vrai
   *   quand l'appel vient de la route `@Public()` ; faux quand l'appelant l'a
   *   déjà fait (`findByRestaurant`) ou n'y est pas soumis.
   */
  async getRestaurantStats(restaurantId: string, assertVisible = false) {
    if (assertVisible) {
      const visible = await this.prisma.restaurant.findFirst({
        where: { id: restaurantId, ...PUBLIC_VENDOR_WHERE },
        select: { id: true },
      });
      if (!visible) throw new NotFoundException('Restaurant non trouvé');
    }

    // PERFORMANCE (fix P0, audit du 28/08/2026) : la méthode chargeait **tous**
    // les avis du vendeur en mémoire pour calculer une moyenne et un
    // histogramme. À 10 000 avis, c'est 10 000 lignes transférées à chaque
    // affichage de fiche vendeur — sur une route publique, donc un
    // amplificateur de charge gratuit. `groupBy` fait le travail côté
    // PostgreSQL, avec l'index (restaurantId, rating).
    const grouped = await this.prisma.review.groupBy({
      by: ['rating'],
      // Lot B : un avis masqué par la modération ne compte plus.
      where: { restaurantId, ...VISIBLE_REVIEW_WHERE },
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
    // F-30 — route publique : liste blanche, et seulement les avis d'une
    // boutique visible (un avis d'un vendeur suspendu ne se lit plus par id).
    const review = await this.prisma.review.findFirst({
      where: { id, ...VISIBLE_REVIEW_WHERE, restaurant: PUBLIC_VENDOR_WHERE },
      select: {
        ...PUBLIC_REVIEW_SELECT,
        restaurant: { select: { id: true, nom: true } },
      },
    });

    if (!review) {
      throw new NotFoundException('Avis non trouvé');
    }

    return {
      message: 'Avis récupéré avec succès',
      data: toPublicReview(review),
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

    // Lot B : un avis masqué ne se réécrit pas — l'admin le rétablirait sans
    // savoir que le texte jugé a changé. Le filtre `hiddenAt: null` porte
    // aussi la course « masqué entre la lecture et l'écriture ».
    const hiddenConflict = new ConflictException(
      'Cet avis a été masqué par la modération : il ne peut plus être modifié.',
    );
    if (review.hiddenAt) throw hiddenConflict;

    const updatedReview = await this.prisma.review
      .update({
        where: { id, hiddenAt: null },
        data: {
          rating: dto.rating,
          comment: dto.comment,
        },
        omit: {
          hiddenById: true,
          hiddenReason: true,
          vendorReplyHiddenAt: true,
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
      })
      .catch((error: unknown) => {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2025'
        ) {
          throw hiddenConflict;
        }
        throw error;
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
      // Lot B : l'identifiant de l'admin modérateur ne sort pas.
      omit: { hiddenById: true, hiddenReason: true, vendorReplyHiddenAt: true },
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
        ...REVIEWABLE_ORDER_WHERE,
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

  /**
   * Lot B — avis reçus par les boutiques du vendeur (propriétaire ou membre
   * qui traite les commandes). Le vendeur voit la note, le commentaire et sa
   * réponse, jamais l'identité du client (D4.d) : la commande est désignée par
   * sa référence courte, comme ailleurs côté vendeur.
   */
  async listForVendor(
    userId: string,
    opts: { restaurantId?: string; page?: number; limit?: number } = {},
  ) {
    const page = opts.page ?? 1;
    const limit = opts.limit ?? 20;
    const shopIds = await accessibleShopIds(this.prisma, userId, 'ORDERS');
    if (opts.restaurantId && !shopIds.includes(opts.restaurantId)) {
      throw new ForbiddenException("Cette boutique n'est pas la vôtre.");
    }
    const ids = opts.restaurantId ? [opts.restaurantId] : shopIds;
    const where: Prisma.ReviewWhereInput = {
      restaurantId: { in: ids },
      ...VISIBLE_REVIEW_WHERE,
    };

    const [rows, total, grouped] = await Promise.all([
      this.prisma.review.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          rating: true,
          comment: true,
          createdAt: true,
          restaurantId: true,
          orderId: true,
          vendorReply: true,
          vendorReplyAt: true,
          vendorReplyHiddenAt: true,
          restaurant: { select: { nom: true } },
        },
      }),
      this.prisma.review.count({ where }),
      this.prisma.review.groupBy({
        by: ['rating'],
        where,
        _count: { rating: true },
      }),
    ]);

    const ratingDistribution: Record<1 | 2 | 3 | 4 | 5, number> = {
      1: 0,
      2: 0,
      3: 0,
      4: 0,
      5: 0,
    };
    let sum = 0;
    let count = 0;
    for (const row of grouped) {
      count += row._count.rating;
      sum += row.rating * row._count.rating;
      if (row.rating >= 1 && row.rating <= 5) {
        ratingDistribution[row.rating as 1 | 2 | 3 | 4 | 5] = row._count.rating;
      }
    }

    return {
      data: rows.map(({ orderId, vendorReplyHiddenAt, restaurant, ...r }) => ({
        ...r,
        restaurantName: restaurant.nom,
        orderRef: orderId ? orderId.slice(-6).toUpperCase() : null,
        author: 'Client',
        vendorReplyHidden: vendorReplyHiddenAt != null,
      })),
      stats: {
        averageRating: count > 0 ? Math.round((sum / count) * 10) / 10 : 0,
        totalReviews: count,
        ratingDistribution,
      },
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  /**
   * Lot B (D4.c) — réponse publique du vendeur : une seule par avis,
   * modifiable. Réservée à qui gère la boutique (`SETTINGS` : propriétaire ou
   * gérant), puisqu'elle parle au nom de la boutique.
   */
  async replyAsVendor(userId: string, reviewId: string, text: string) {
    const review = await this.prisma.review.findUnique({
      where: { id: reviewId },
      select: {
        restaurantId: true,
        hiddenAt: true,
        vendorReplyHiddenAt: true,
      },
    });
    // Même réponse pour « inexistant » et « pas votre boutique » : un vendeur
    // ne sonde pas les avis des autres.
    if (
      !review ||
      !(await canAccessShop(
        this.prisma,
        userId,
        review.restaurantId,
        'SETTINGS',
      ))
    ) {
      throw new NotFoundException('Avis non trouvé');
    }
    if (review.hiddenAt) {
      throw new ConflictException(
        'Cet avis a été masqué par la modération : il ne peut plus recevoir de réponse.',
      );
    }
    if (review.vendorReplyHiddenAt) {
      throw new ConflictException(
        'Votre réponse a été masquée par la modération. Contactez le support Lilia.',
      );
    }

    // Écriture conditionnelle : un masquage admin entre la lecture et
    // l'écriture n'est pas écrasé par la réponse.
    const vendorReply = text.trim();
    const vendorReplyAt = new Date();
    const { count } = await this.prisma.review.updateMany({
      where: { id: reviewId, hiddenAt: null, vendorReplyHiddenAt: null },
      data: { vendorReply, vendorReplyAt },
    });
    if (count === 0) {
      throw new ConflictException(
        "L'avis vient d'être modéré : rechargez la liste.",
      );
    }
    return {
      message: 'Réponse publiée',
      data: { id: reviewId, vendorReply, vendorReplyAt },
    };
  }
}
