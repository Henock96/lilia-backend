import {
  DeliveryPlace,
  DeliverySubsidyPolicy,
  DeliveryTariffSnapshot,
  quoteDelivery,
  subsidyFor,
} from './delivery-pricing.engine';

/**
 * Simulations de la tarification de livraison (F3-02) — fonctions pures.
 *
 * Elles répondent à deux questions avant qu'un geste ne coûte de l'argent :
 *  - l'admin : « si je publie ce brouillon, que paient les clients et sur
 *    quelle assiette sont payés les livreurs ? » ;
 *  - le vendeur : « si j'offre cette part de la livraison, combien cela
 *    m'aurait-il coûté sur mes dernières commandes ? ».
 *
 * Même moteur que le checkout (`quoteDelivery`, `subsidyFor`) : une
 * simulation qui calculerait autrement ne prouverait rien.
 */

export type Centroids = ReadonlyMap<
  string,
  { latitude: number | null; longitude: number | null }
>;

/**
 * Position du vendeur, dans l'ordre de `DeliveryPricingService.vendorPlace` :
 * GPS du vendeur, sinon centroïde de son quartier.
 */
export function vendorPlace(
  vendor: {
    quartierId: string | null;
    latitude: number | null;
    longitude: number | null;
  },
  centroids: Centroids,
): DeliveryPlace {
  if (vendor.latitude != null && vendor.longitude != null) {
    return vendor;
  }
  const c = vendor.quartierId ? centroids.get(vendor.quartierId) : undefined;
  return {
    quartierId: vendor.quartierId,
    latitude: c?.latitude ?? null,
    longitude: c?.longitude ?? null,
  };
}

/**
 * Destination, dans l'ordre de `DeliveryPricingService.destinationPlace` :
 * centroïde du quartier d'abord (R-02.1), point de l'adresse en repli.
 */
export function destinationPlace(
  dest: {
    quartierId: string | null;
    latitude: number | null;
    longitude: number | null;
  },
  centroids: Centroids,
): DeliveryPlace {
  const c = dest.quartierId ? centroids.get(dest.quartierId) : undefined;
  if (c?.latitude != null && c.longitude != null) {
    return {
      quartierId: dest.quartierId,
      latitude: c.latitude,
      longitude: c.longitude,
    };
  }
  return dest;
}

export interface SimulatedOrder {
  vendor: {
    quartierId: string | null;
    latitude: number | null;
    longitude: number | null;
  };
  destination: {
    quartierId: string | null;
    latitude: number | null;
    longitude: number | null;
  };
  /** Assiette réellement retenue à l'époque (prix de base, sinon brut). */
  historicalBaseXaf: number;
}

export interface TariffReplay {
  orders: number;
  historicalBaseXaf: number;
  simulatedBaseXaf: number;
  /** simulé − historique : > 0 = les clients (et l'assiette livreur) montent. */
  deltaXaf: number;
  /** Commandes chiffrées à la tranche la plus haute faute de position. */
  fallbackOrders: number;
  byBasis: Record<'OVERRIDE' | 'BAND' | 'FALLBACK', number>;
}

/**
 * Rejoue des commandes passées sous une grille (subvention ignorée : on
 * compare des prix de base, la subvention est un choix du vendeur).
 */
export function replayTariff(
  tariff: DeliveryTariffSnapshot,
  orders: readonly SimulatedOrder[],
  centroids: Centroids,
): TariffReplay {
  const byBasis = { OVERRIDE: 0, BAND: 0, FALLBACK: 0 };
  let historical = 0;
  let simulated = 0;
  for (const order of orders) {
    const quote = quoteDelivery({
      tariff,
      origin: vendorPlace(order.vendor, centroids),
      destination: destinationPlace(order.destination, centroids),
      subsidy: NO_SUBSIDY,
      subTotalXaf: 0,
    });
    historical += order.historicalBaseXaf;
    simulated += quote.baseFeeXaf;
    byBasis[quote.basis] += 1;
  }
  return {
    orders: orders.length,
    historicalBaseXaf: historical,
    simulatedBaseXaf: simulated,
    deltaXaf: simulated - historical,
    fallbackOrders: byBasis.FALLBACK,
    byBasis,
  };
}

export interface PairPrice {
  vendorId: string;
  vendorName: string;
  quartierId: string;
  quartierName: string;
  baseFeeXaf: number;
  distanceKm: number | null;
  basis: 'OVERRIDE' | 'BAND' | 'FALLBACK';
}

/**
 * Matrice vendeur → quartier : « une commande de Poto-Poto vers Talangaï ».
 * Utile tant qu'il n'y a pas d'historique à rejouer (0 commande payée en
 * production au 23/09/2026).
 */
export function priceMatrix(
  tariff: DeliveryTariffSnapshot,
  vendors: ReadonlyArray<{
    id: string;
    nom: string;
    quartierId: string | null;
    latitude: number | null;
    longitude: number | null;
  }>,
  quartiers: ReadonlyArray<{
    id: string;
    nom: string;
    latitude: number | null;
    longitude: number | null;
  }>,
): PairPrice[] {
  const centroids: Centroids = new Map(quartiers.map((q) => [q.id, q]));
  const rows: PairPrice[] = [];
  for (const vendor of vendors) {
    const origin = vendorPlace(vendor, centroids);
    for (const quartier of quartiers) {
      const quote = quoteDelivery({
        tariff,
        origin,
        destination: destinationPlace(
          { quartierId: quartier.id, latitude: null, longitude: null },
          centroids,
        ),
        subsidy: NO_SUBSIDY,
        subTotalXaf: 0,
      });
      rows.push({
        vendorId: vendor.id,
        vendorName: vendor.nom,
        quartierId: quartier.id,
        quartierName: quartier.nom,
        baseFeeXaf: quote.baseFeeXaf,
        distanceKm: quote.distanceKm,
        basis: quote.basis,
      });
    }
  }
  return rows;
}

export interface SubsidySimulation {
  orders: number;
  /** Ce que la subvention aurait retenu sur les reversements. */
  costXaf: number;
  /** Commandes pour lesquelles le client aurait payé moins. */
  subsidizedOrders: number;
}

/**
 * Coût d'un réglage de subvention sur des commandes livrées passées : même
 * `subsidyFor` que le moteur, appliqué au prix de base de chaque commande.
 */
export function simulateSubsidy(
  policy: DeliverySubsidyPolicy,
  orders: ReadonlyArray<{ baseFeeXaf: number; subTotalXaf: number }>,
): SubsidySimulation {
  let cost = 0;
  let subsidized = 0;
  for (const order of orders) {
    const subsidy = subsidyFor(policy, order.baseFeeXaf, order.subTotalXaf);
    cost += subsidy;
    if (subsidy > 0) subsidized += 1;
  }
  return { orders: orders.length, costXaf: cost, subsidizedOrders: subsidized };
}

const NO_SUBSIDY: DeliverySubsidyPolicy = {
  mode: 'NONE',
  amountXaf: null,
  thresholdXaf: null,
};
