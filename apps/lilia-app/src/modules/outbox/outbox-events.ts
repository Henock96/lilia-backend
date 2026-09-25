/**
 * Obligations durables portées par l'outbox (Master Audit v1, lot 4).
 *
 * Chacune est écrite DANS la transaction de la transition qui la crée : si la
 * commande est `LIVRER` ou `ANNULER` en base, l'obligation l'est aussi. Le
 * processus peut mourir juste après le commit — le worker la dépilera.
 *
 * Les effets restent aussi déclenchés immédiatement par le processus web (pour
 * la latence) : l'outbox est le filet, pas le chemin principal. C'est sûr
 * parce que chaque effet est **idempotent** par contrainte d'unicité en base
 * (`LoyaltyTransaction @@unique([orderId, type])`, `ReferralReward.orderId`,
 * index partiel `Refund_orderId_auto_uq`) : le rejouer ne crédite ni ne
 * rembourse deux fois.
 */

/** Commande livrée → points de fidélité + récompense de parrainage. */
export const ORDER_DELIVERED_EVENT = 'order.delivered';

/** Commande payée annulée → ouverture de la ligne de remboursement. */
export const ORDER_REFUND_DUE_EVENT = 'order.refund_due';

/**
 * Commande expirée faute de paiement → prévenir le client.
 *
 * L'expiration tourne dans le worker, qui ne charge AUCUN listener
 * d'événements : l'`order.cancelled` qu'elle émet n'y est entendu par personne
 * (finding F-10). Sans cette obligation, le client ne l'apprenait jamais.
 */
export const ORDER_EXPIRED_EVENT = 'order.expired';

/**
 * Commande payée que le vendeur n'a pas acceptée à temps (Phase 3, F3-01) →
 * prévenir le client (remboursement lancé) et le vendeur (commande perdue).
 *
 * Écrite par le cron du worker, qui n'a aucun listener : sans l'outbox,
 * personne ne l'apprendrait.
 */
export const ORDER_ACCEPTANCE_EXPIRED_EVENT = 'order.acceptance_expired';

/**
 * Versement vendeur abouti / en échec (F3-07). Écrits avec la transition du
 * versement : c'est souvent le worker qui la conclut (réconciliation,
 * versement automatique), et il n'a pas d'écouteur d'événements en mémoire.
 * Dépilés par `PayoutOutboxEffectsService`.
 */
export const PAYOUT_SUCCEEDED_EVENT = 'payout.succeeded';
export const PAYOUT_FAILED_EVENT = 'payout.failed';

/**
 * F3-08 — un geste financier attend un second administrateur. Écrit avec la
 * demande ; dépilé par `ApprovalOutboxEffectsService`, qui prévient les
 * autres administrateurs porteurs de `FINANCE_APPROVE`.
 */
export const APPROVAL_REQUESTED_EVENT = 'approval.requested';
