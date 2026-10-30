import { OrderStatus } from '@prisma/client';

/**
 * Seuils d'immobilité par état de commande (audit du 28/10/2026, point 6).
 *
 * ## Pourquoi un `Record<OrderStatus, …>`
 *
 * Les files « À traiter » étaient une liste blanche de cas : `PAYER` en
 * retard, `ACCEPTEE`/`PRET` sans livreur, `EN_ROUTE` au-delà d'une heure… Tout
 * état oublié était invisible — c'est ainsi qu'une commande est restée
 * `EN_ROUTE` quatorze jours (audit du 20/09), puis que `EN_PREPARATION`, le
 * retrait `PRET` et le livreur assigné qui ne vient pas l'étaient encore.
 *
 * Indexée par l'enum, cette table **ne compile pas** si un statut est ajouté
 * sans que son comportement de supervision soit décidé.
 *
 * ## Ce que mesure un seuil
 *
 * Le temps passé **dans l'état courant**, lu sur la dernière ligne
 * `OrderHistory` qui y est entrée — pas `updatedAt`, qu'une écriture sans
 * rapport (note, preuve, livreur) remet à zéro. À défaut d'historique
 * (commande antérieure à son écriture), `updatedAt` sert de repli, et l'item
 * le dit.
 *
 * ## Contexte
 *
 * - `delivery` / `pickup` : livraison ou retrait au comptoir ;
 * - `assigned` : livraison avec un livreur affecté qui n'a pas récupéré.
 * `null` = pas de seuil dans ce contexte (l'état n'y a pas de sens).
 *
 * Valeurs **initiales**, à valider par l'exploitation (décision D-8 de
 * l'audit). Elles se changent ici, par une PR : c'est la trace du changement.
 *
 * ⚠️ La supervision signale ; elle ne fait JAMAIS avancer une commande. Aucune
 * transition automatique vers un état final ne découle d'un seuil.
 */
export type StaleRule = {
  delivery: number | null;
  pickup: number | null;
  /** Livraison dont le livreur est affecté mais n'a rien récupéré. */
  assigned?: number;
  /** Ce que l'opérateur doit faire. */
  action: string;
  label: string;
};

export const ORDER_STALE_RULES: Record<OrderStatus, StaleRule | 'TERMINAL'> = {
  // Lot 3 — signalée AVANT son expiration automatique (5 min par défaut,
  // `vendorRequestTimeoutMinutes`) : l'opérateur a encore le temps d'appeler.
  DEMANDE_ENVOYEE: {
    delivery: 3,
    pickup: 3,
    label: 'Demande sans réponse du vendeur',
    action:
      'Appeler la boutique : le client attend sa réponse avant de payer. Sans réponse, la demande expire seule (rien n’est encaissé).',
  },
  EN_ATTENTE: {
    delivery: 20,
    pickup: 20,
    label: 'Paiement en attente',
    action:
      'Interroger le prestataire (« Réconcilier ») ; si le client affirme avoir payé, rechercher la transaction.',
  },
  PAYER: {
    delivery: 5,
    pickup: 5,
    label: 'Payée, pas encore acceptée',
    action:
      'Appeler la boutique : la commande est payée et attend son acceptation.',
  },
  ACCEPTEE: {
    delivery: 20,
    pickup: 20,
    assigned: 20,
    label: 'Acceptée, préparation non commencée',
    action: 'Appeler la boutique pour confirmer qu’elle prépare.',
  },
  EN_PREPARATION: {
    delivery: 45,
    pickup: 45,
    assigned: 45,
    label: 'En préparation depuis trop longtemps',
    action: 'Appeler la boutique : la commande n’est toujours pas prête.',
  },
  PRET: {
    delivery: 15,
    pickup: 60,
    assigned: 15,
    label: 'Prête, non récupérée',
    action:
      'Livraison : affecter ou relancer le livreur. Retrait : appeler le client.',
  },
  EN_ROUTE: {
    delivery: 60,
    pickup: null,
    label: 'En route depuis trop longtemps',
    action: 'Appeler le livreur, puis le client.',
  },
  LIVRER: 'TERMINAL',
  ANNULER: 'TERMINAL',
  ECHEC_LIVRAISON: 'TERMINAL',
};

export type StaleContext = 'delivery' | 'pickup' | 'assigned';

/** Seuil applicable, ou `null` si aucun dans ce contexte. */
export function staleThresholdMinutes(
  status: OrderStatus,
  context: StaleContext,
): number | null {
  const rule = ORDER_STALE_RULES[status];
  if (rule === 'TERMINAL') return null;
  if (context === 'assigned') return rule.assigned ?? rule.delivery;
  return rule[context];
}

/** États surveillés (non terminaux). */
export const SUPERVISED_ORDER_STATUSES = (
  Object.keys(ORDER_STALE_RULES) as OrderStatus[]
).filter((s) => ORDER_STALE_RULES[s] !== 'TERMINAL');

/** Seuils des opérations d'argent « en vol » (minutes). */
export const IN_FLIGHT_THRESHOLDS = {
  /** Versement vendeur `PENDING` chez le prestataire. */
  payoutPendingMinutes: 30,
  /** Remboursement `PROCESSING` chez le prestataire. */
  refundProcessingMinutes: 30,
  /** Réclamation `IN_PROGRESS` sans nouveau message. */
  claimStalledMinutes: 24 * 60,
} as const;
