import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { AdminAuditAction, Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { AdminReviewsQueryDto } from './dto';

/** Ce que l'admin modère : l'avis, la réponse du vendeur, ou la note livreur. */
export type ModerationTarget = 'REVIEW' | 'VENDOR_REPLY' | 'DELIVERY_REVIEW';

/**
 * Lot B (D4.b) — modération des avis : **masquer** plutôt que supprimer.
 *
 * Un avis masqué sort de la liste publique, des moyennes du vendeur ou du
 * livreur et de la vue vendeur ; il reste en base, réversible, et chaque geste
 * laisse une ligne `AdminAuditLog` (acteur, motif). La suppression physique
 * (`DELETE /admin/reviews/:id`) reste pour la compatibilité, sans écran.
 *
 * Chaque écriture est conditionnelle (`updateMany … WHERE hiddenAt IS NULL`) :
 * deux admins qui masquent en même temps produisent un masquage et un 409.
 */
@Injectable()
export class ReviewModerationService {
  private readonly logger = new Logger(ReviewModerationService.name);

  constructor(private readonly prisma: PrismaService) {}

  async listReviews(query: AdminReviewsQueryDto) {
    const { page, limit } = query;
    const where: Prisma.ReviewWhereInput = {
      ...(query.rating ? { rating: query.rating } : {}),
      ...(query.restaurantId ? { restaurantId: query.restaurantId } : {}),
      ...visibilityWhere(query.visibility),
    };
    const [rows, total] = await Promise.all([
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
          orderId: true,
          restaurantId: true,
          hiddenAt: true,
          hiddenReason: true,
          vendorReply: true,
          vendorReplyAt: true,
          vendorReplyHiddenAt: true,
          user: { select: { nom: true } },
          restaurant: { select: { nom: true } },
        },
      }),
      this.prisma.review.count({ where }),
    ]);
    return {
      data: rows,
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  async listDeliveryReviews(query: AdminReviewsQueryDto) {
    const { page, limit } = query;
    const where: Prisma.DeliveryReviewWhereInput = {
      ...(query.rating ? { rating: query.rating } : {}),
      ...(query.delivererId ? { delivererId: query.delivererId } : {}),
      ...visibilityWhere(query.visibility),
    };
    const [rows, total] = await Promise.all([
      this.prisma.deliveryReview.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          rating: true,
          comment: true,
          createdAt: true,
          orderId: true,
          delivererId: true,
          hiddenAt: true,
          hiddenReason: true,
          user: { select: { nom: true } },
          deliverer: { select: { nom: true } },
        },
      }),
      this.prisma.deliveryReview.count({ where }),
    ]);
    return {
      data: rows,
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  hide(target: ModerationTarget, id: string, adminId: string, reason: string) {
    return this.setHidden(target, id, adminId, reason);
  }

  unhide(target: ModerationTarget, id: string, adminId: string) {
    return this.setHidden(target, id, adminId, null);
  }

  private async setHidden(
    target: ModerationTarget,
    id: string,
    adminId: string,
    reason: string | null,
  ) {
    const hiding = reason !== null;
    const now = new Date();

    await this.prisma.$transaction(async (tx) => {
      let count: number;
      if (target === 'DELIVERY_REVIEW') {
        ({ count } = await tx.deliveryReview.updateMany({
          where: { id, hiddenAt: hiding ? null : { not: null } },
          data: hiding
            ? { hiddenAt: now, hiddenById: adminId, hiddenReason: reason }
            : { hiddenAt: null, hiddenById: null, hiddenReason: null },
        }));
      } else if (target === 'REVIEW') {
        ({ count } = await tx.review.updateMany({
          where: { id, hiddenAt: hiding ? null : { not: null } },
          data: hiding
            ? { hiddenAt: now, hiddenById: adminId, hiddenReason: reason }
            : { hiddenAt: null, hiddenById: null, hiddenReason: null },
        }));
      } else {
        ({ count } = await tx.review.updateMany({
          where: {
            id,
            vendorReply: { not: null },
            vendorReplyHiddenAt: hiding ? null : { not: null },
          },
          data: { vendorReplyHiddenAt: hiding ? now : null },
        }));
      }

      if (count === 0) {
        await this.explainNoop(tx, target, id, hiding);
      }

      await tx.adminAuditLog.create({
        data: {
          actorId: adminId,
          action: hiding
            ? AdminAuditAction.REVIEW_HIDDEN
            : AdminAuditAction.REVIEW_UNHIDDEN,
          targetType:
            target === 'DELIVERY_REVIEW' ? 'DeliveryReview' : 'Review',
          targetId: id,
          reason,
          metadata: { kind: target },
        },
      });
    });

    this.logger.log(
      `[MODÉRATION] ${target} ${id} ${hiding ? 'masqué' : 'rétabli'} par ${adminId}`,
    );
    return { data: { id, target, hidden: hiding } };
  }

  /** Aucune ligne écrite : introuvable (404) ou déjà dans l'état voulu (409). */
  private async explainNoop(
    tx: Prisma.TransactionClient,
    target: ModerationTarget,
    id: string,
    hiding: boolean,
  ): Promise<never> {
    const exists =
      target === 'DELIVERY_REVIEW'
        ? await tx.deliveryReview.count({ where: { id } })
        : await tx.review.count({
            where:
              target === 'VENDOR_REPLY'
                ? { id, vendorReply: { not: null } }
                : { id },
          });
    if (exists === 0) {
      throw new NotFoundException(
        target === 'VENDOR_REPLY'
          ? 'Aucune réponse du vendeur sur cet avis.'
          : 'Avis non trouvé.',
      );
    }
    throw new ConflictException(
      hiding ? 'Déjà masqué.' : "Ce n'est pas masqué.",
    );
  }
}

function visibilityWhere(visibility: AdminReviewsQueryDto['visibility']): {
  hiddenAt?: null | { not: null };
} {
  if (visibility === 'visible') return { hiddenAt: null };
  if (visibility === 'hidden') return { hiddenAt: { not: null } };
  return {};
}
