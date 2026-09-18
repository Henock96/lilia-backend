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
 * Part maximale d'un partage de frais de livraison, en pourcentage.
 *
 * ⚠️ Distinct de `MAX_COMMISSION_PERCENT`, et c'est essentiel : un livreur
 * indépendant touche 65 % de la course. Soumettre un partage au plafond de
 * commission (50) ramènerait sa part à 50 % **en silence** — il serait sous-payé
 * sans qu'aucune erreur ne parte. Deux notions, deux plafonds.
 */
export const MAX_SHARE_PERCENT = 100;

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
 * Pourcentage de partage → points de base.
 *
 * Asymétrie **délibérée** avec `percentToBasisPoints` : celui-ci **écrête**
 * silencieusement à 50 %, ce qui convient à une commission (un taux aberrant
 * saisi par erreur vaut mieux borné que refusé au moment de payer un vendeur).
 * Un partage de course, lui, **lève** : le taux vient d'un contrat et d'un
 * réglage d'administration, pas d'une saisie de masse. Le ramener en douce de
 * 65 % à 50 % sous-paierait un livreur sans que rien ne le signale.
 */
function sharePercentToBasisPoints(percent: number): number {
  if (!Number.isFinite(percent) || percent < 0 || percent > MAX_SHARE_PERCENT) {
    throw new Error(
      `Taux de partage invalide : ${percent} (attendu entre 0 et ${MAX_SHARE_PERCENT}).`,
    );
  }
  return Math.round(percent * 100);
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

export interface DeliverySplit {
  /** Assiette du partage, en XAF entiers. */
  baseXaf: number;
  /** Taux réellement appliqué, figé avec le partage. */
  driverSharePercent: number;
  /** Ce que touche le livreur pour cette course. */
  driverPayXaf: number;
  /** Ce que Lilia Food garde. **Résidu**, jamais un second calcul. */
  liliaShareXaf: number;
}

/**
 * Partage les frais de livraison entre le livreur et Lilia Food.
 *
 * ```
 * driverPayXaf  = round(baseXaf × driverSharePercent)
 * liliaShareXaf = baseXaf − driverPayXaf          ← RÉSIDU
 * ```
 *
 * ## Pourquoi la part de Lilia est un résidu et non un second pourcentage
 *
 * Appliquer deux taux complémentaires à la même base ne recompose pas la base :
 * `round(333 × 35 %) + round(333 × 65 %)` vaut **334**, pas 333. Un franc
 * fabriqué à chaque course. En rendant la part de Lilia égale au reste,
 * `driverPay + liliaShare === base` devient vrai **par construction** — il n'y
 * a pas d'arrondi à réconcilier, et aucun test ne peut le prendre en défaut.
 *
 * C'est aussi la raison pour laquelle un seul taux est stocké en base : deux
 * valeurs indépendantes finissent toujours par diverger.
 *
 * ## Pourquoi c'est la part du LIVREUR qui est stockée
 *
 * C'est le nombre du contrat — « tu touches 35 % de la course » — et celui que
 * le livreur vérifiera dans son application. Le nombre qu'un humain recompte
 * doit être l'exact, pas le dérivé.
 *
 * `baseXaf` n'est **pas** `Order.deliveryFee` : c'est le tarif **avant remise
 * commerciale** (`Order.deliveryFeeGross`). Une livraison offerte par Lilia est
 * une campagne de Lilia ; le livreur a roulé et doit être payé. Même règle que
 * pour le vendeur, dont le reversement ignore déjà les remises.
 */
export function computeDeliverySplit(params: {
  baseXaf: number;
  driverSharePercent: number;
}): DeliverySplit {
  const baseXaf = toXaf(params.baseXaf, 'base de partage de la course');
  const bps = sharePercentToBasisPoints(params.driverSharePercent);
  const driverPayXaf = applyBasisPoints(baseXaf, bps);

  return {
    baseXaf,
    driverSharePercent: bps / 100,
    driverPayXaf,
    liliaShareXaf: baseXaf - driverPayXaf,
  };
}
