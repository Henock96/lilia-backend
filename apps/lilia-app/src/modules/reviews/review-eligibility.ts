import { OrderStatus, Prisma } from '@prisma/client';
import type { DeliveryProof } from '../orders/order-transition.types';

/**
 * Lot B (15/11/2026, D4.a) — une commande ne s'évalue que si sa remise est
 * **prouvée**. `LIVRER` seul ne suffit pas :
 *  - `DELIVERY_UNVERIFIED`, `PICKUP_VENDOR_DECLARED` : rien n'atteste que le
 *    client a reçu son repas ;
 *  - `DELIVERY_ADMIN_OVERRIDE` : clôture par l'admin, le plus souvent un client
 *    qui a refusé la commande (D1.c, « pas d'avis possible dessus »).
 *
 * Liste distincte de `AUTO_PAYOUT_PROOFS` : la clôture admin paie le vendeur
 * mais n'ouvre pas d'avis.
 */
export const REVIEWABLE_PROOFS: readonly DeliveryProof[] = [
  'DELIVERY_CODE',
  'PICKUP_CODE',
  'PICKUP_CUSTOMER_CONFIRMED',
  'PICKUP_ADMIN_OVERRIDE',
];

/** Filtre Prisma : commande livrée avec une preuve qui ouvre l'avis. */
export const REVIEWABLE_ORDER_WHERE = {
  status: OrderStatus.LIVRER,
  deliveryProof: { in: [...REVIEWABLE_PROOFS] },
} satisfies Prisma.OrderWhereInput;

export function isReviewableProof(proof: string | null | undefined): boolean {
  return (
    proof != null && (REVIEWABLE_PROOFS as readonly string[]).includes(proof)
  );
}

/** `CAN` : invite à noter ; `DONE` : déjà noté ; `NO` : pas de note possible. */
export type ReviewSlot = 'CAN' | 'DONE' | 'NO';

export interface OrderReviewVerdict {
  vendor: ReviewSlot;
  driver: ReviewSlot;
}

/**
 * Verdict publié sur `GET /orders/:id` pour le client propriétaire : les apps
 * affichent l'invite sans recopier la règle.
 */
export function orderReviewVerdict(
  order: {
    status: string;
    deliveryProof: string | null;
    isDelivery: boolean;
    delivery?: { status: string; delivererId: string | null } | null;
  },
  existing: { vendor: boolean; driver: boolean },
): OrderReviewVerdict {
  const reviewable =
    order.status === 'LIVRER' && isReviewableProof(order.deliveryProof);
  const driverReviewable =
    reviewable &&
    order.isDelivery &&
    order.delivery?.status === 'LIVRER' &&
    !!order.delivery.delivererId;
  return {
    vendor: !reviewable ? 'NO' : existing.vendor ? 'DONE' : 'CAN',
    driver: !driverReviewable ? 'NO' : existing.driver ? 'DONE' : 'CAN',
  };
}

/**
 * Auteur affiché publiquement : « Prénom I. » (approbation du 15/11). Le nom
 * complet du client ne quitte plus le serveur sur une route publique.
 */
export function publicAuthorName(nom: string | null | undefined): string {
  const parts = (nom ?? '').trim().split(/\s+/).filter(Boolean);
  // Un « nom » qui porte un e-mail ou un numéro ne sort jamais en public.
  if (parts.length === 0 || /[@\d]/.test(parts[0])) return 'Client';
  if (parts.length === 1) return parts[0];
  // `Array.from` : une initiale hors BMP (emoji…) n'est pas coupée en deux.
  const initial = Array.from(parts[parts.length - 1])[0].toUpperCase();
  return `${parts[0]} ${initial}.`;
}
