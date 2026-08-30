import { OnboardingStatus, Prisma } from '@prisma/client';

/**
 * Définition unique de « ce vendeur est visible d'un client ».
 *
 * Trois conditions **indépendantes**, chacune décidée par un acteur différent :
 *
 * | Condition | Question posée | Décidée par |
 * |---|---|---|
 * | `onboardingStatus = ACTIVATED` | sa boutique est-elle configurée et publiée ? | admin, à l'activation |
 * | `adminApproved` | ce commerce a-t-il sa place sur la marketplace ? | admin, à la validation |
 * | `isActive` | est-il suspendu ? | admin, à la sanction |
 *
 * Elles étaient jusqu'ici recopiées à la main sur quatorze requêtes. Une
 * condition oubliée sur une seule d'entre elles suffit à exposer un vendeur qui
 * ne devrait pas l'être — c'est exactement comme cela que `GET /vendor-photos`
 * rendait la galerie de vendeurs non validés. Une constante partagée rend la
 * règle vérifiable d'un seul endroit.
 *
 * ⚠️ Ne **jamais** l'employer sur les vues d'administration ni sur
 * `findMyRestaurant` : un vendeur doit voir sa propre boutique pendant qu'il la
 * configure, et un admin doit voir tout ce qu'il supervise.
 */
export const PUBLIC_VENDOR_WHERE = {
  onboardingStatus: OnboardingStatus.ACTIVATED,
  adminApproved: true,
  isActive: true,
} as const satisfies Prisma.RestaurantWhereInput;

/**
 * Même règle, exprimée sur une relation `restaurant` imbriquée (produits,
 * menus, photos).
 */
export const PUBLIC_VENDOR_RELATION_WHERE = {
  restaurant: PUBLIC_VENDOR_WHERE,
} as const satisfies Prisma.ProductWhereInput;
