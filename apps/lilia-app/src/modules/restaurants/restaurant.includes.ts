/* eslint-disable prettier/prettier */
import { Prisma } from '@prisma/client';

/**
 * Constantes `include` Prisma partagées entre les services restaurants
 * (extrait de restaurants.service.ts — LIL-145).
 */

/** Tri galerie : image de couverture d'abord, puis ordre d'affichage. */
export const PHOTOS_GALLERY = {
  orderBy: [{ isCover: 'desc' }, { displayOrder: 'asc' }],
} satisfies Prisma.Restaurant$photosArgs;

/** Include standard pour les réponses restaurant */
export const RESTAURANT_INCLUDE = {
  specialties: true,
  operatingHours: true,
  photos: PHOTOS_GALLERY,
} satisfies Prisma.RestaurantInclude;

/** Include avec reviews pour le calcul de note */
export const RESTAURANT_WITH_REVIEWS = {
  ...RESTAURANT_INCLUDE,
  reviews: { select: { rating: true } },
} satisfies Prisma.RestaurantInclude;
