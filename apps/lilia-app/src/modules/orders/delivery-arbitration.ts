import { OrderStatus } from '@prisma/client';

/**
 * Arbitrage de livraison (retours produit du 15/11/2026, décision D1) —
 * l'ADMIN clôture une livraison « malgré tout », par exemple quand le client
 * refuse une commande qu'il a payée.
 *
 * La commande passe `PRET → EN_ROUTE → LIVRER` (ou `EN_ROUTE → LIVRER`) sans
 * que le livreur ait confirmé quoi que ce soit, avec la preuve
 * `DELIVERY_ADMIN_OVERRIDE` : le vendeur est payé par le circuit normal. Le
 * client n'est pas remboursé ; l'administration peut lui offrir un avoir.
 * Ni points de fidélité ni parrainage (D1.c).
 *
 * Liste TypeScript, pas d'enum PostgreSQL (règle 14) : le motif vit dans les
 * métadonnées du journal d'audit et dans `OrderHistory.reason`.
 */
export const DELIVERY_ARBITRATION_REASONS = [
  /** Le client a refusé la commande à la livraison. */
  'CUSTOMER_REFUSED',
  /** Le livreur a livré sans pouvoir l'enregistrer dans son application. */
  'DRIVER_DID_NOT_CONFIRM',
  /** La commande a été remise hors de l'application (support, vendeur). */
  'DELIVERED_OUTSIDE_APP',
  /** Autre cas : la note est alors obligatoire. */
  'OTHER',
] as const;

export type DeliveryArbitrationReason =
  (typeof DELIVERY_ARBITRATION_REASONS)[number];

/** Libellés de l'historique de commande (lu par le support). */
export const DELIVERY_ARBITRATION_LABELS: Record<
  DeliveryArbitrationReason,
  string
> = {
  CUSTOMER_REFUSED: 'refus du client',
  DRIVER_DID_NOT_CONFIRM: 'livraison non enregistrée par le livreur',
  DELIVERED_OUTSIDE_APP: 'remise hors application',
  OTHER: 'autre motif',
};

export interface DeliveryArbitration {
  reason: DeliveryArbitrationReason;
  note?: string;
  /** Avoir offert au client, en XAF entiers. Absent : aucun avoir. */
  voucherAmountXaf?: number;
  voucherExpiresInDays?: number;
}

/** États d'où l'arbitrage part : la commande est prête ou déjà en route. */
export const DELIVERY_ARBITRABLE_STATUSES: readonly OrderStatus[] = [
  OrderStatus.PRET,
  OrderStatus.EN_ROUTE,
];

/**
 * Verdict publié avec la commande : l'interface affiche le bouton si et
 * seulement si le serveur accepterait le geste (hors capacité et MFA, que la
 * route revérifie). Champ séparé d'`allowedActions` : les applications
 * installées y lisent un vocabulaire fermé.
 */
export function deliveryArbitrable(
  order: { status: OrderStatus; isDelivery: boolean },
  role: string,
): boolean {
  return (
    role === 'ADMIN' &&
    order.isDelivery &&
    DELIVERY_ARBITRABLE_STATUSES.includes(order.status)
  );
}
