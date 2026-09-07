import { PrismaClient } from '@prisma/client';

/** Note moyenne arrondie au dixième, et nombre d'avis. */
export type VendorRating = {
  averageRating: number | null;
  totalReviews: number;
};

export const NO_RATING: VendorRating = { averageRating: null, totalReviews: 0 };

/**
 * Moyenne + nombre d'avis, calculés **par PostgreSQL**.
 *
 * Extrait de `RestaurantQueryService` (où il était privé) pour que
 * `GET /vendors/:id` puisse le servir aussi : la note du vendeur était présente
 * sur la fiche du site et **absente** de l'écran de l'application, qui affichait
 * donc un commerce sans étoiles alors que ses avis existaient.
 *
 * ⚠️ Ne jamais revenir à `include: { reviews: { select: { rating } } }` : cette
 * version chargeait la totalité des avis d'un vendeur pour afficher une seule
 * étoile — 10 000 lignes transférées par carte affichée (fix P0, août 2026).
 */
export async function aggregateRatings(
  prisma: Pick<PrismaClient, 'review'>,
  restaurantIds: string[],
): Promise<Map<string, VendorRating>> {
  if (restaurantIds.length === 0) return new Map();

  const grouped = await prisma.review.groupBy({
    by: ['restaurantId'],
    where: { restaurantId: { in: restaurantIds } },
    _avg: { rating: true },
    _count: { rating: true },
  });

  return new Map(
    grouped.map((row) => [
      row.restaurantId,
      {
        averageRating:
          row._avg.rating !== null
            ? Math.round(row._avg.rating * 10) / 10
            : null,
        totalReviews: row._count.rating,
      },
    ]),
  );
}

/** Note d'un seul vendeur — le cas des deux routes de détail. */
export async function ratingOf(
  prisma: Pick<PrismaClient, 'review'>,
  restaurantId: string,
): Promise<VendorRating> {
  const ratings = await aggregateRatings(prisma, [restaurantId]);
  return ratings.get(restaurantId) ?? NO_RATING;
}
