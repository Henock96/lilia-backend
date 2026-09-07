/**
 * Événements du programme de fidélité.
 *
 * ⚠️ **Ils sont émis HORS de la transaction financière, jamais dedans.**
 *
 * Un crédit de points est un mouvement comptable ; une notification est un
 * confort. Émettre l'événement dans la transaction ferait dépendre le premier
 * du second : une panne FCM, un token expiré ou un simple délai réseau
 * annuleraient un point légitimement acquis. L'ordre est donc toujours :
 * la base d'abord, le téléphone ensuite.
 *
 * L'idempotence du crédit protège du même coup celle de la notification : le
 * second passage n'écrit rien, donc n'émet rien.
 */

export class LoyaltyPointsEarnedEvent {
  constructor(
    readonly userId: string,
    readonly orderId: string,
    /** Points crédités par cette commande. */
    readonly points: number,
    /** Valeur unitaire au moment du crédit, en XAF — pour le libellé du push. */
    readonly pointValueXaf: number,
  ) {}
}

export class ReferralRewardGrantedEvent {
  constructor(
    /** Bénéficiaire du point. */
    readonly referrerId: string,
    /** Filleul dont la première commande livrée a déclenché la récompense. */
    readonly referredUserId: string,
    /** Commande qualifiante. */
    readonly orderId: string,
    readonly points: number,
  ) {}
}
