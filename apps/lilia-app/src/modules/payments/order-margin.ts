import { applyBasisPoints } from './money.util';

/**
 * Marge par commande, avec la qualité de ses postes (durcissement lot 5, D-3).
 *
 * Complète `RestaurantPayoutService.buildContribution`, qui reste la seule
 * source du revenu et des coûts connus. Ce module y ajoute les frais du
 * prestataire, que rien n'écrit en base aujourd'hui :
 *
 *  - `CONFIRMED` : valeur réelle portée par le paiement ou le versement ;
 *  - `ESTIMATED` : taux de la grille du contrat, saisi par l'administrateur ;
 *  - `UNKNOWN`   : ni l'un ni l'autre. Jamais 0, qui en ferait « gratuit ».
 *
 * La marge porte la plus faible qualité de ses postes. Une estimation ne vit
 * que dans cette vue : elle n'entre jamais au grand livre (audit §5.3).
 */
export const MARGIN_QUALITIES = ['CONFIRMED', 'ESTIMATED', 'UNKNOWN'] as const;
export type MarginQuality = (typeof MARGIN_QUALITIES)[number];

export interface MarginCost {
  amountXaf: number | null;
  quality: MarginQuality;
}

/** Frais réels s'ils existent, sinon le taux du contrat, sinon inconnu. */
export function resolveProviderFee(
  actualXaf: number | null,
  baseXaf: number,
  estimatedBps: number | null,
): MarginCost {
  if (actualXaf !== null) return { amountXaf: actualXaf, quality: 'CONFIRMED' };
  if (estimatedBps !== null) {
    return {
      amountXaf: applyBasisPoints(baseXaf, estimatedBps),
      quality: 'ESTIMATED',
    };
  }
  return { amountXaf: null, quality: 'UNKNOWN' };
}

export interface OrderMargin {
  /** Hors frais prestataire ; `null` si le coût livreur est inconnu. */
  marginBeforeProviderFeesXaf: number | null;
  collectionFee: MarginCost;
  payoutFee: MarginCost;
  /** `null` dès qu'un poste est inconnu : une marge partielle n'en est pas une. */
  marginXaf: number | null;
  quality: MarginQuality;
}

export function orderMargin(input: {
  marginBeforeProviderFeesXaf: number | null;
  collectionFee: MarginCost;
  payoutFee: MarginCost;
}): OrderMargin {
  const { marginBeforeProviderFeesXaf, collectionFee, payoutFee } = input;
  const unknown =
    marginBeforeProviderFeesXaf === null ||
    collectionFee.amountXaf === null ||
    payoutFee.amountXaf === null;
  if (unknown) {
    return { ...input, marginXaf: null, quality: 'UNKNOWN' };
  }
  const estimated =
    collectionFee.quality === 'ESTIMATED' || payoutFee.quality === 'ESTIMATED';
  return {
    ...input,
    marginXaf:
      marginBeforeProviderFeesXaf -
      collectionFee.amountXaf! -
      payoutFee.amountXaf!,
    quality: estimated ? 'ESTIMATED' : 'CONFIRMED',
  };
}

export interface MarginSummary {
  orders: number;
  byQuality: Record<MarginQuality, number>;
  /** Somme des seules marges connues, à lire avec `byQuality`. */
  knownMarginXaf: number;
}

export function summarizeMargins(
  rows: ReadonlyArray<Pick<OrderMargin, 'marginXaf' | 'quality'>>,
): MarginSummary {
  const byQuality: Record<MarginQuality, number> = {
    CONFIRMED: 0,
    ESTIMATED: 0,
    UNKNOWN: 0,
  };
  let knownMarginXaf = 0;
  for (const row of rows) {
    byQuality[row.quality] += 1;
    knownMarginXaf += row.marginXaf ?? 0;
  }
  return { orders: rows.length, byQuality, knownMarginXaf };
}

/** Période lue par défaut quand `from` manque (lot 6, L6-2). */
export const MARGINS_DEFAULT_PERIOD_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Bornes incluses de la période des marges (lot 6, L6-2).
 *
 * Sans `from`, la période remonte de 30 jours depuis `to` (ou maintenant) :
 * une lecture sans borne parcourait tout l'historique jusqu'au plafond de
 * lignes. Un `to` en date seule (`2026-11-19`) couvre toute la journée UTC,
 * pas seulement sa première milliseconde. `null` si `from` est après `to`.
 */
export function resolveMarginPeriod(
  query: { from?: string; to?: string },
  now: Date,
): { from: Date; to: Date } | null {
  const to = !query.to
    ? now
    : DATE_ONLY.test(query.to)
      ? new Date(new Date(query.to).getTime() + DAY_MS - 1)
      : new Date(query.to);
  const from = query.from
    ? new Date(query.from)
    : new Date(to.getTime() - MARGINS_DEFAULT_PERIOD_DAYS * DAY_MS);
  return from.getTime() > to.getTime() ? null : { from, to };
}
