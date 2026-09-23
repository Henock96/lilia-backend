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
 * `Refund @@unique([orderId])`) : le rejouer ne crédite ni ne rembourse deux
 * fois.
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
