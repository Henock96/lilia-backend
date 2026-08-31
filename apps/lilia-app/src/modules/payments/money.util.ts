/**
 * Arithmétique monétaire en XAF.
 *
 * Le franc CFA n'a pas de sous-unité : tout montant est un **entier**. Les
 * colonnes Prisma sont encore en `Float` (dette M12, migration planifiée
 * séparément), mais aucun calcul ne doit s'appuyer sur cette représentation.
 *
 * Le piège concret : `5000 * 10 / 100` vaut bien 500, mais `subTotal * 8.5 / 100`
 * sur un sous-total de 1 234 donne `104.88999999999999`. Arrondir en fin de
 * chaîne masque le problème une fois ; l'enchaîner sur commission puis reste dû
 * fait dériver le total de quelques francs, et un vendeur qui recompte ses
 * reversements le voit.
 *
 * La parade est de ne jamais quitter les entiers : le pourcentage est converti
 * en **points de base** (1 % = 100 bps), et la seule division intervient sur des
 * entiers, une fois.
 */

/** Plafond défensif : un montant XAF au-delà signale une donnée corrompue. */
export const MAX_AMOUNT_XAF = 100_000_000;

/** Commission maximale acceptée, en pourcentage. */
export const MAX_COMMISSION_PERCENT = 50;

/**
 * Normalise un montant venant de la base (`Float`) en entier XAF.
 *
 * Lève sur une valeur inexploitable plutôt que de propager un `NaN` jusqu'au
 * prestataire, où il deviendrait un `INVALID_AMOUNT` opaque.
 */
export function toXaf(value: number, label = 'montant'): number {
  if (!Number.isFinite(value)) {
    throw new Error(`${label} invalide : ${value}`);
  }
  const rounded = Math.round(value);
  if (rounded < 0) {
    throw new Error(`${label} négatif : ${value}`);
  }
  if (rounded > MAX_AMOUNT_XAF) {
    throw new Error(`${label} hors bornes : ${value}`);
  }
  return rounded;
}

/**
 * Pourcentage → points de base.
 *
 * `10` → `1000`, `8.5` → `850`, `12.25` → `1225`. Deux décimales suffisent
 * largement pour un taux de commission, et cadrent la précision une bonne fois.
 */
export function percentToBasisPoints(percent: number): number {
  if (!Number.isFinite(percent) || percent < 0) {
    throw new Error(`Taux de commission invalide : ${percent}`);
  }
  const bounded = Math.min(percent, MAX_COMMISSION_PERCENT);
  return Math.round(bounded * 100);
}

/**
 * Applique un pourcentage à un montant entier, en arithmétique entière.
 *
 * `gross` et `bps` sont entiers ; le produit reste dans les entiers sûrs de
 * JavaScript (10⁸ × 5 000 = 5×10¹¹, très en deçà de 2⁵³). L'unique division est
 * arrondie au franc le plus proche.
 */
export function applyBasisPoints(
  amountXaf: number,
  basisPoints: number,
): number {
  return Math.round((amountXaf * basisPoints) / 10_000);
}

export interface PayoutBreakdown {
  /** Montant des produits revenant au vendeur. */
  grossAmount: number;
  /** Taux appliqué, en pourcentage (tel qu'il sera figé sur le reversement). */
  commissionPercent: number;
  /** Commission retenue par Lilia Food. */
  commissionAmount: number;
  /** Montant NET effectivement envoyé au vendeur. */
  payoutAmount: number;
}

/**
 * Décompose ce qui revient au vendeur.
 *
 * ```
 * grossAmount    = montant des produits (Order.subTotal)
 * commission     = grossAmount × commissionPercent
 * payoutAmount   = grossAmount − commission
 * ```
 *
 * **Ce qui n'entre PAS dans le calcul**, et c'est délibéré :
 *  · `serviceFee` — frais payés en plus par le client, ils appartiennent à
 *    Lilia Food et ne sont pas de l'argent du vendeur, donc rien à en déduire ;
 *  · `deliveryFee` — rémunère la livraison, pas le vendeur ;
 *  · `discountAmount` — code promo et points de fidélité sont une remise
 *    consentie par Lilia Food. Les déduire ferait payer au vendeur une campagne
 *    marketing qu'il n'a pas décidée ;
 *  · les frais du prestataire de paiement — charge de Lilia Food, jamais
 *    répercutée sur le reversement.
 *
 * Si l'un de ces choix devait changer, c'est **ici** qu'il changerait, et les
 * tests financiers le verrouillent.
 */
export function computePayoutBreakdown(params: {
  subTotalXaf: number;
  commissionPercent: number;
}): PayoutBreakdown {
  const grossAmount = toXaf(params.subTotalXaf, 'sous-total de la commande');
  const bps = percentToBasisPoints(params.commissionPercent);
  const commissionAmount = applyBasisPoints(grossAmount, bps);
  const payoutAmount = grossAmount - commissionAmount;

  return {
    grossAmount,
    // Reflète le taux réellement appliqué après bornage, pas celui demandé :
    // c'est lui qu'on fige sur le reversement, il doit être vrai.
    commissionPercent: bps / 100,
    commissionAmount,
    payoutAmount,
  };
}
