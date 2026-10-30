import { Prisma } from '@prisma/client';

/**
 * Ce qu'une route **publique** rend d'un avis — liste blanche (audit du
 * 28/10/2026, F-30 ; règle 15 de la constitution).
 *
 * `GET /reviews/restaurant/:id` et `GET /reviews/:id` renvoyaient la ligne
 * `Review` entière par `include:` : `userId` et `orderId` (identifiants
 * internes, dans des dépôts publics) partaient avec chaque avis, plus `user.id`.
 * Aucun client ne les lit — l'app reconnaît « mon avis » par `review.id`.
 *
 * Une colonne ajoutée plus tard à `Review` est masquée par défaut : c'est le
 * sens d'une liste blanche.
 */
export const PUBLIC_REVIEW_SELECT = {
  id: true,
  rating: true,
  comment: true,
  restaurantId: true,
  createdAt: true,
  updatedAt: true,
  user: { select: { nom: true, imageUrl: true } },
} satisfies Prisma.ReviewSelect;

/** Clés qu'aucune réponse publique d'avis ne doit porter (tests). */
export const REVIEW_PUBLIC_FORBIDDEN_KEYS = [
  'userId',
  'orderId',
  'email',
  'phone',
];
