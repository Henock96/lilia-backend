import { DeliveryTariffSnapshot } from './delivery-pricing.engine';
import {
  destinationPlace,
  priceMatrix,
  replayTariff,
  simulateSubsidy,
  vendorPlace,
} from './delivery-simulation';

/**
 * Simulateurs F3-02 : ils doivent chiffrer exactement comme le checkout —
 * même ordre de résolution des positions, même moteur.
 */
const TARIFF: DeliveryTariffSnapshot = {
  version: 2,
  roadFactor: 1.3,
  bands: [
    { maxKm: 3, feeXaf: 1000 },
    { maxKm: 6, feeXaf: 1500 },
  ],
  overrides: [
    { originQuartierId: 'q-poto', destQuartierId: 'q-talangai', feeXaf: 1200 },
  ],
};

const CENTROIDS = new Map([
  ['q-poto', { latitude: -4.2634, longitude: 15.2729 }],
  ['q-moungali', { latitude: -4.2454, longitude: 15.2629 }],
  ['q-talangai', { latitude: -4.2134, longitude: 15.2729 }],
  ['q-vide', { latitude: null, longitude: null }],
]);

describe('résolution des positions (même ordre que DeliveryPricingService)', () => {
  it('vendeur : son GPS prime sur le centroïde de son quartier', () => {
    expect(
      vendorPlace(
        { quartierId: 'q-poto', latitude: -4.1, longitude: 15.1 },
        CENTROIDS,
      ),
    ).toEqual({ quartierId: 'q-poto', latitude: -4.1, longitude: 15.1 });
  });

  it('vendeur sans GPS : centroïde de son quartier', () => {
    expect(
      vendorPlace(
        { quartierId: 'q-moungali', latitude: null, longitude: null },
        CENTROIDS,
      ),
    ).toEqual({
      quartierId: 'q-moungali',
      latitude: -4.2454,
      longitude: 15.2629,
    });
  });

  it('destination : le centroïde prime sur le point de l’adresse (R-02.1)', () => {
    expect(
      destinationPlace(
        { quartierId: 'q-talangai', latitude: -4.0, longitude: 15.0 },
        CENTROIDS,
      ),
    ).toEqual({
      quartierId: 'q-talangai',
      latitude: -4.2134,
      longitude: 15.2729,
    });
  });

  it('destination dans un quartier sans centroïde : le point de l’adresse', () => {
    expect(
      destinationPlace(
        { quartierId: 'q-vide', latitude: -4.0, longitude: 15.0 },
        CENTROIDS,
      ),
    ).toEqual({ quartierId: 'q-vide', latitude: -4.0, longitude: 15.0 });
  });
});

describe('replayTariff', () => {
  const vendor = { quartierId: 'q-poto', latitude: null, longitude: null };

  it('additionne prix historique et prix simulé, et compte les bases', () => {
    const replay = replayTariff(
      TARIFF,
      [
        // surcharge Poto → Talangaï
        {
          vendor,
          destination: {
            quartierId: 'q-talangai',
            latitude: null,
            longitude: null,
          },
          historicalBaseXaf: 1000,
        },
        // ~2,9 km routiers → tranche 1
        {
          vendor,
          destination: {
            quartierId: 'q-moungali',
            latitude: null,
            longitude: null,
          },
          historicalBaseXaf: 1000,
        },
        // position inconnue → tranche la plus haute
        {
          vendor,
          destination: {
            quartierId: 'q-vide',
            latitude: null,
            longitude: null,
          },
          historicalBaseXaf: 1000,
        },
      ],
      CENTROIDS,
    );
    expect(replay).toEqual({
      orders: 3,
      historicalBaseXaf: 3000,
      simulatedBaseXaf: 1200 + 1000 + 1500,
      deltaXaf: 700,
      fallbackOrders: 1,
      byBasis: { OVERRIDE: 1, BAND: 1, FALLBACK: 1 },
    });
  });

  it('aucune commande : un rejeu vide, pas une erreur', () => {
    expect(replayTariff(TARIFF, [], CENTROIDS)).toMatchObject({
      orders: 0,
      deltaXaf: 0,
    });
  });
});

describe('priceMatrix', () => {
  it('une ligne par couple vendeur × quartier, la surcharge appliquée', () => {
    const rows = priceMatrix(
      TARIFF,
      [
        {
          id: 'v1',
          nom: 'Chez Poto',
          quartierId: 'q-poto',
          latitude: null,
          longitude: null,
        },
      ],
      [
        {
          id: 'q-talangai',
          nom: 'Talangaï',
          latitude: -4.2134,
          longitude: 15.2729,
        },
        { id: 'q-vide', nom: 'Sans centre', latitude: null, longitude: null },
      ],
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      vendorId: 'v1',
      quartierName: 'Talangaï',
      baseFeeXaf: 1200,
      basis: 'OVERRIDE',
    });
    expect(rows[1]).toMatchObject({ baseFeeXaf: 1500, basis: 'FALLBACK' });
  });
});

describe('simulateSubsidy', () => {
  const orders = [
    { baseFeeXaf: 1000, subTotalXaf: 4000 },
    { baseFeeXaf: 1500, subTotalXaf: 12000 },
    { baseFeeXaf: 400, subTotalXaf: 9000 },
  ];

  it('FIXED : plafonné au prix de base de chaque commande', () => {
    expect(
      simulateSubsidy(
        { mode: 'FIXED', amountXaf: 500, thresholdXaf: null },
        orders,
      ),
    ).toEqual({ orders: 3, costXaf: 500 + 500 + 400, subsidizedOrders: 3 });
  });

  it('FREE_ABOVE : seulement les paniers au-dessus du seuil (inclus)', () => {
    expect(
      simulateSubsidy(
        { mode: 'FREE_ABOVE', amountXaf: null, thresholdXaf: 9000 },
        orders,
      ),
    ).toEqual({ orders: 3, costXaf: 1500 + 400, subsidizedOrders: 2 });
  });

  it('NONE : rien', () => {
    expect(
      simulateSubsidy(
        { mode: 'NONE', amountXaf: null, thresholdXaf: null },
        orders,
      ),
    ).toEqual({ orders: 3, costXaf: 0, subsidizedOrders: 0 });
  });
});
