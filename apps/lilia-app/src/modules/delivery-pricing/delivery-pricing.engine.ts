import { haversineKm } from '../../common/geo/congo-geo';

/**
 * Moteur de tarification de la livraison (Phase 3, F3-02).
 *
 * ## Pourquoi
 *
 * Le vendeur fixait le prix de la course (`fixedDeliveryFee`, zones), et ce
 * prix était aussi l'assiette de la paie livreur : un vendeur à 0 XAF faisait
 * rouler un livreur indépendant gratuitement (finding F-05). La plateforme
 * fixe désormais le PRIX DE BASE ; le vendeur peut seulement en OFFRIR une
 * part, déduite de son propre reversement.
 *
 * ## Règles
 *
 *  1. Une surcharge explicite pour la paire (quartier du vendeur → quartier du
 *     client) prime ; elle est orientée.
 *  2. Sinon : distance à vol d'oiseau × `roadFactor`, arrondie au dixième, et
 *     première tranche dont `maxKm` la couvre (borne incluse) ; au-delà de la
 *     dernière, le prix de la dernière.
 *  3. Position inconnue d'un côté : tranche la plus haute, signalée
 *     `FALLBACK` — on ne refuse pas une commande pour une donnée manquante,
 *     et on ne l'offre pas non plus.
 *  4. Subvention vendeur plafonnée au prix de base : prix client ≥ 0 et
 *     prix client + subvention = prix de base, toujours.
 *  5. Décision D3 : la paie livreur est un pourcentage du PRIX DE BASE — il
 *     ne dépend donc jamais de la subvention (vérifié par les tests).
 *
 * Fonction pure, sans I/O : la même sert au devis public et au checkout, qui
 * ne peuvent donc pas diverger.
 */
export interface DeliveryTariffSnapshot {
  version: number;
  roadFactor: number;
  bands: ReadonlyArray<{ maxKm: number; feeXaf: number }>;
  overrides: ReadonlyArray<{
    originQuartierId: string;
    destQuartierId: string;
    feeXaf: number;
  }>;
}

export interface DeliveryPlace {
  quartierId: string | null;
  latitude: number | null;
  longitude: number | null;
}

export interface DeliverySubsidyPolicy {
  mode: 'NONE' | 'FIXED' | 'FREE_ABOVE';
  amountXaf: number | null;
  thresholdXaf: number | null;
}

export interface DeliveryQuote {
  tariffVersion: number;
  /** Prix de base plateforme = assiette de la paie livreur. */
  baseFeeXaf: number;
  /** Part offerte par le vendeur, déduite de son reversement. */
  subsidyXaf: number;
  /** Ce que paie le client (avant un éventuel code promo). */
  customerFeeXaf: number;
  distanceKm: number | null;
  basis: 'OVERRIDE' | 'BAND' | 'FALLBACK';
}

export function quoteDelivery(input: {
  tariff: DeliveryTariffSnapshot;
  origin: DeliveryPlace;
  destination: DeliveryPlace;
  subsidy: DeliverySubsidyPolicy;
  subTotalXaf: number;
}): DeliveryQuote {
  const { tariff, origin, destination } = input;
  const bands = [...tariff.bands].sort((a, b) => a.maxKm - b.maxKm);
  if (bands.length === 0) {
    throw new Error(
      `La grille de livraison v${tariff.version} n'a aucune tranche.`,
    );
  }
  const highest = bands[bands.length - 1];

  let baseFeeXaf: number;
  let distanceKm: number | null = null;
  let basis: DeliveryQuote['basis'];

  const override =
    origin.quartierId && destination.quartierId
      ? tariff.overrides.find(
          (o) =>
            o.originQuartierId === origin.quartierId &&
            o.destQuartierId === destination.quartierId,
        )
      : undefined;

  if (override) {
    baseFeeXaf = override.feeXaf;
    basis = 'OVERRIDE';
  } else if (
    origin.latitude != null &&
    origin.longitude != null &&
    destination.latitude != null &&
    destination.longitude != null
  ) {
    const raw =
      haversineKm(
        origin.latitude,
        origin.longitude,
        destination.latitude,
        destination.longitude,
      ) * tariff.roadFactor;
    distanceKm = Math.round(raw * 10) / 10;
    const band = bands.find((b) => distanceKm! <= b.maxKm) ?? highest;
    baseFeeXaf = band.feeXaf;
    basis = 'BAND';
  } else {
    baseFeeXaf = highest.feeXaf;
    basis = 'FALLBACK';
  }

  const subsidyXaf = subsidyFor(input.subsidy, baseFeeXaf, input.subTotalXaf);
  return {
    tariffVersion: tariff.version,
    baseFeeXaf,
    subsidyXaf,
    customerFeeXaf: baseFeeXaf - subsidyXaf,
    distanceKm,
    basis,
  };
}

export function subsidyFor(
  policy: DeliverySubsidyPolicy,
  baseFeeXaf: number,
  subTotalXaf: number,
): number {
  switch (policy.mode) {
    case 'FIXED':
      return Math.min(Math.max(policy.amountXaf ?? 0, 0), baseFeeXaf);
    case 'FREE_ABOVE':
      return policy.thresholdXaf != null && subTotalXaf >= policy.thresholdXaf
        ? baseFeeXaf
        : 0;
    case 'NONE':
      return 0;
  }
}
