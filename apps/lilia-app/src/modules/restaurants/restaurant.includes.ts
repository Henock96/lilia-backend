import { Prisma } from '@prisma/client';

/**
 * Constantes `include` Prisma partagées entre les services restaurants
 * (extrait de restaurants.service.ts — LIL-145).
 */

/** Tri galerie : image de couverture d'abord, puis ordre d'affichage. */
export const PHOTOS_GALLERY = {
  orderBy: [{ isCover: 'desc' }, { displayOrder: 'asc' }],
} satisfies Prisma.Restaurant$photosArgs;

/** Include standard pour les réponses restaurant (détail) */
export const RESTAURANT_INCLUDE = {
  specialties: true,
  operatingHours: true,
  photos: PHOTOS_GALLERY,
} satisfies Prisma.RestaurantInclude;

/**
 * Include allégé pour les LISTES (fix P0, audit du 28/08/2026).
 *
 * `GET /restaurants` est public, non authentifié, et servait `specialties +
 * operatingHours + toute la galerie photos` pour chaque vendeur : à 200
 * vendeurs, plusieurs mégaoctets par appel sur la 4G de Brazzaville — et un
 * amplificateur de charge idéal pour saturer le serveur sans même se
 * connecter. Une carte de liste n'affiche qu'une photo de couverture.
 */
export const RESTAURANT_LIST_INCLUDE = {
  specialties: true,
  operatingHours: true,
  photos: { ...PHOTOS_GALLERY, take: 1 },
} satisfies Prisma.RestaurantInclude;

// ⚠️ `RESTAURANT_WITH_REVIEWS` a été SUPPRIMÉ (fix P0, audit du 28/08/2026).
// Il chargeait tous les avis d'un vendeur (`reviews: { select: { rating } }`)
// uniquement pour afficher une moyenne. Le calcul se fait désormais côté
// PostgreSQL — voir `RestaurantQueryService.aggregateRatings`.
