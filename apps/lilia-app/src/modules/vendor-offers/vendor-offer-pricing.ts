import type { VendorOfferKind } from '@prisma/client';

/**
 * Offres boutique (F3-11) — règles d'argent, pures.
 *
 * Tout ce qui décide d'un montant d'offre vit ici, sans base ni horloge
 * implicite : le checkout, le devis serveur et l'aperçu d'un code promo
 * passent par ces fonctions, jamais par un calcul local. Deux implémentations
 * d'une même remise divergent, et c'est le client qui voit la différence entre
 * le total affiché et le montant débité.
 */

/** Q2 — bornes vendeur. Hors bornes : refus, pas de validation admin. */
export const VENDOR_OFFER_MAX_PERCENT = 50;
export const VENDOR_OFFER_MAX_DAYS = 30;

export interface OfferTerms {
  kind: VendorOfferKind;
  value: number;
  minSubTotalXaf: number;
  maxDiscountXaf: number | null;
}

/**
 * Remise d'une offre sur un sous-total, en XAF entiers, **avant** le plafond
 * « reversement ≥ 0 » ({@link capOfferToVendorNet}). `0` sous le seuil.
 */
export function offerDiscountXaf(
  offer: OfferTerms,
  subTotalXaf: number,
): number {
  if (subTotalXaf <= 0 || subTotalXaf < offer.minSubTotalXaf) return 0;
  let discount =
    offer.kind === 'PERCENT'
      ? Math.round((subTotalXaf * offer.value) / 100)
      : offer.value;
  if (offer.maxDiscountXaf !== null) {
    discount = Math.min(discount, offer.maxDiscountXaf);
  }
  return Math.max(0, Math.min(discount, subTotalXaf));
}

/**
 * La remise vendeur ne peut pas dépasser ce que le vendeur touchera sur la
 * commande. Le reversement a un plancher à 0 (`computePayoutBreakdown`) : au
 *-delà, c'est Lilia qui paierait le reste, sans l'avoir décidé — exactement
 * ce que D8 interdit.
 */
export function capOfferToVendorNet(
  discountXaf: number,
  order: {
    subTotalXaf: number;
    commissionAmountXaf: number;
    vendorDeliverySubsidyXaf: number;
  },
): number {
  const vendorNet =
    order.subTotalXaf -
    order.commissionAmountXaf -
    order.vendorDeliverySubsidyXaf;
  return Math.max(0, Math.min(discountXaf, vendorNet));
}

const xaf = (n: number) => `${n.toLocaleString('fr-FR')} FCFA`;

/** Libellé client : « −10 % sur toute la boutique », « −500 FCFA dès 5 000 FCFA d’achat ». */
export function offerLabel(offer: OfferTerms): string {
  if (offer.kind === 'PERCENT') {
    const base = `−${offer.value} % sur toute la boutique`;
    const withThreshold =
      offer.minSubTotalXaf > 0
        ? `${base} dès ${xaf(offer.minSubTotalXaf)}`
        : base;
    return offer.maxDiscountXaf !== null
      ? `${withThreshold} (jusqu’à ${xaf(offer.maxDiscountXaf)})`
      : withThreshold;
  }
  return `−${xaf(offer.value)} dès ${xaf(offer.minSubTotalXaf)} d’achat`;
}

export type OfferTermsErrorCode =
  | 'OFFER_PERCENT_OUT_OF_RANGE'
  | 'OFFER_THRESHOLD_INVALID'
  | 'OFFER_WINDOW_INVALID'
  | 'OFFER_TOO_LONG'
  | 'OFFER_BUDGET_REQUIRED'
  | 'OFFER_BUDGET_TOO_SMALL';

export class OfferTermsError extends Error {
  constructor(
    readonly code: OfferTermsErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Bornes vendeur (R-11.6, Q2). Mêmes bornes que les CHECK de la migration
 * `vendor_offers` : le service les dit en français, la base les garantit.
 */
export function assertOfferTerms(
  terms: OfferTerms & { startsAt: Date; endsAt: Date; budgetXaf: number },
  now: Date,
): void {
  if (terms.kind === 'PERCENT') {
    if (
      !Number.isInteger(terms.value) ||
      terms.value < 1 ||
      terms.value > VENDOR_OFFER_MAX_PERCENT
    ) {
      throw new OfferTermsError(
        'OFFER_PERCENT_OUT_OF_RANGE',
        `La remise doit être comprise entre 1 et ${VENDOR_OFFER_MAX_PERCENT} %.`,
      );
    }
  } else if (
    !Number.isInteger(terms.value) ||
    terms.value <= 0 ||
    terms.value * 2 > terms.minSubTotalXaf ||
    terms.maxDiscountXaf !== null
  ) {
    throw new OfferTermsError(
      'OFFER_THRESHOLD_INVALID',
      'Une remise fixe exige un montant d’achat minimal au moins deux fois supérieur à la remise.',
    );
  }

  const opensAt = Math.max(terms.startsAt.getTime(), now.getTime());
  if (terms.endsAt.getTime() <= opensAt) {
    throw new OfferTermsError(
      'OFFER_WINDOW_INVALID',
      'La date de fin doit être postérieure au début de l’offre.',
    );
  }
  const maxMs = VENDOR_OFFER_MAX_DAYS * 24 * 3_600_000;
  if (terms.endsAt.getTime() - terms.startsAt.getTime() > maxMs) {
    throw new OfferTermsError(
      'OFFER_TOO_LONG',
      `Une offre dure au plus ${VENDOR_OFFER_MAX_DAYS} jours.`,
    );
  }

  if (!Number.isInteger(terms.budgetXaf) || terms.budgetXaf <= 0) {
    throw new OfferTermsError(
      'OFFER_BUDGET_REQUIRED',
      'Indiquez le budget maximal que vous acceptez de financer.',
    );
  }
  if (terms.kind === 'FIXED_THRESHOLD' && terms.budgetXaf < terms.value) {
    throw new OfferTermsError(
      'OFFER_BUDGET_TOO_SMALL',
      'Le budget doit couvrir au moins une remise.',
    );
  }
}
