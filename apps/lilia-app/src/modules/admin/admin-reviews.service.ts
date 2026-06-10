import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Modération des avis côté admin (LIL-134) : liste paginée et suppression.
 * Extrait de `AdminService` — API publique inchangée.
 */
@Injectable()
export class AdminReviewsService {
  private readonly logger = new Logger(AdminReviewsService.name);

  constructor(private prisma: PrismaService) {}

  async getAllReviews(page = 1, limit = 20) {
    const [reviews, total] = await Promise.all([
      this.prisma.review.findMany({
        include: {
          user: { select: { nom: true, email: true } },
          restaurant: { select: { nom: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.review.count(),
    ]);

    return { data: reviews, total, page, limit };
  }

  async deleteReview(reviewId: string) {
    const review = await this.prisma.review.findUnique({
      where: { id: reviewId },
    });
    if (!review) throw new NotFoundException('Avis non trouvé');

    await this.prisma.review.delete({ where: { id: reviewId } });
    this.logger.warn(`Avis ${reviewId} supprimé par admin`);

    return { message: 'Avis supprimé' };
  }
}
