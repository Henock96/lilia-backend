/**
 * 1B (ADM-03, décision D-1 du 13/10/2026) — motifs d'un arbitrage de remise.
 *
 * Clôturer un retrait à la place du client et du vendeur pose la preuve
 * `PICKUP_ADMIN_OVERRIDE`, qui ouvre une échéance de versement vendeur. Le
 * geste doit donc dire **pourquoi**, dans une liste fermée qu'on peut compter.
 *
 * Liste TypeScript, pas d'enum PostgreSQL (règle 14) : le motif vit dans les
 * métadonnées JSON du journal d'audit et dans `OrderHistory.reason`, et la
 * liste peut évoluer sans migration.
 */
export const PICKUP_ARBITRATION_REASONS = [
  /** Le client a bien emporté sa commande sans pouvoir montrer son code. */
  'CUSTOMER_COLLECTED_NO_CODE',
  /** Le client a confirmé la remise au support (appel, message). */
  'CUSTOMER_CONFIRMED_TO_SUPPORT',
  /** Le vendeur a remis la commande mais n'a pas pu l'enregistrer. */
  'VENDOR_COULD_NOT_RECORD',
  /** Autre cas : la note est alors obligatoire. */
  'OTHER',
] as const;

export type PickupArbitrationReason =
  (typeof PICKUP_ARBITRATION_REASONS)[number];

export interface PickupArbitration {
  reason: PickupArbitrationReason;
  note?: string;
}

/** Variable d'environnement qui ferme l'ancien chemin (route de statut). */
export const PICKUP_ARBITRATION_ENFORCED_ENV =
  'ADMIN_PICKUP_ARBITRATION_ENFORCED';
