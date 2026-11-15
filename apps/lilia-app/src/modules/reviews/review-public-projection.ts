import { Prisma } from '@prisma/client';
import { publicAuthorName } from './review-eligibility';

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
 * sens d'une liste blanche. Les colonnes de modération (`hidden*`) n'y entrent
 * pas : un avis masqué n'est jamais lu par une route publique.
 */
export const PUBLIC_REVIEW_SELECT = {
  id: true,
  rating: true,
  comment: true,
  restaurantId: true,
  createdAt: true,
  updatedAt: true,
  vendorReply: true,
  vendorReplyAt: true,
  vendorReplyHiddenAt: true,
  user: { select: { nom: true, imageUrl: true } },
} satisfies Prisma.ReviewSelect;

/** Avis visibles du public : les avis masqués par l'admin en sortent (lot B). */
export const VISIBLE_REVIEW_WHERE = {
  hiddenAt: null,
} satisfies Prisma.ReviewWhereInput;

type PublicReviewRow = Prisma.ReviewGetPayload<{
  select: typeof PUBLIC_REVIEW_SELECT;
}>;

/**
 * Forme publique d'un avis (lot B) : auteur en « Prénom I. », réponse du
 * vendeur seulement si l'admin ne l'a pas masquée. La date de masquage de la
 * réponse ne sort pas.
 */
export function toPublicReview<T extends PublicReviewRow>(row: T) {
  const { vendorReplyHiddenAt, vendorReply, vendorReplyAt, user, ...rest } =
    row;
  const replyVisible = vendorReply != null && vendorReplyHiddenAt == null;
  return {
    ...rest,
    user: { nom: publicAuthorName(user.nom), imageUrl: user.imageUrl },
    vendorReply: replyVisible ? vendorReply : null,
    vendorReplyAt: replyVisible ? vendorReplyAt : null,
  };
}

/** Clés qu'aucune réponse publique d'avis ne doit porter (tests). */
export const REVIEW_PUBLIC_FORBIDDEN_KEYS = [
  'userId',
  'orderId',
  'email',
  'phone',
  'hiddenAt',
  'hiddenById',
  'hiddenReason',
  'vendorReplyHiddenAt',
];
