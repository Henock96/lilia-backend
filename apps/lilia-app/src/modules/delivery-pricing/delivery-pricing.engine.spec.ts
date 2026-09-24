import {
  DeliveryTariffSnapshot,
  quoteDelivery,
} from './delivery-pricing.engine';

/**
 * Moteur de tarification de la livraison (Phase 3, F3-02).
 *
 * Fonction pure : c'est elle qui fixe ce que paie le client ET l'assiette de
 * la paie livreur (décision D3 : % de ce prix de base, jamais du prix client).
 * Chaque règle a sa ligne.
 */
const TARIFF: DeliveryTariffSnapshot = {
  version: 3,
  roadFactor: 1.3,
  bands: [
    { maxKm: 3, feeXaf: 1000 },
    { maxKm: 6, feeXaf: 1500 },
    { maxKm: 10, feeXaf: 2000 },
  ],
  overrides: [
    { originQuartierId: 'q-poto', destQuartierId: 'q-talangai', feeXaf: 1200 },
  ],
};

// Deux points de Brazzaville à ~2,2 km à vol d'oiseau (≈ 2,9 km par la route).
const POTO = { quartierId: 'q-poto', latitude: -4.2634, longitude: 15.2729 };
const MOUNGALI = {
  quartierId: 'q-moungali',
  latitude: -4.2454,
  longitude: 15.2629,
};
// ~6 km à vol d'oiseau (≈ 7,8 km par la route).
const TALANGAI = {
  quartierId: 'q-talangai',
  latitude: -4.2134,
  longitude: 15.2729,
};
const FAR = { quartierId: 'q-far', latitude: -4.1, longitude: 15.35 };

const noSubsidy = {
  mode: 'NONE' as const,
  amountXaf: null,
  thresholdXaf: null,
};

function quote(over: Partial<Parameters<typeof quoteDelivery>[0]> = {}) {
  return quoteDelivery({
    tariff: TARIFF,
    origin: POTO,
    destination: MOUNGALI,
    subsidy: noSubsidy,
    subTotalXaf: 5000,
    ...over,
  });
}

describe('quoteDelivery — prix de base', () => {
  it('distance réelle × coefficient routier → tranche', () => {
    const q = quote();
    expect(q.basis).toBe('BAND');
    // 2,288 km à vol d'oiseau × 1,3 = 2,97 → arrondi 3,0 : pile sur la borne.
    expect(q.distanceKm).toBe(3);
    expect(q.baseFeeXaf).toBe(1000);
  });

  it('la borne d’une tranche est incluse', () => {
    // Distance à vol d'oiseau arrondie au dixième : 2,3 km.
    const at = (maxKm: number) => ({
      ...TARIFF,
      roadFactor: 1,
      bands: [
        { maxKm, feeXaf: 900 },
        { maxKm: 9, feeXaf: 1800 },
      ],
    });
    expect(quote({ tariff: at(2.3) }).baseFeeXaf).toBe(900);
    // Contre-épreuve : un dixième plus bas, on passe à la tranche suivante.
    expect(quote({ tariff: at(2.2) }).baseFeeXaf).toBe(1800);
  });

  it('une surcharge de paire de quartiers prime sur les tranches', () => {
    const q = quote({ destination: TALANGAI });
    expect(q.basis).toBe('OVERRIDE');
    expect(q.baseFeeXaf).toBe(1200);
  });

  it('la surcharge est orientée (vendeur → client), pas symétrique', () => {
    const q = quote({ origin: TALANGAI, destination: POTO });
    expect(q.basis).toBe('BAND');
  });

  it('au-delà de la dernière tranche : le prix de la dernière', () => {
    expect(quote({ destination: FAR }).baseFeeXaf).toBe(2000);
  });

  it('position inconnue : tranche la plus haute, signalée comme repli', () => {
    const q = quote({
      destination: { quartierId: 'q-x', latitude: null, longitude: null },
    });
    expect(q.basis).toBe('FALLBACK');
    expect(q.baseFeeXaf).toBe(2000);
    expect(q.distanceKm).toBeNull();
  });

  it('même quartier, même point : première tranche', () => {
    expect(quote({ destination: POTO }).baseFeeXaf).toBe(1000);
  });

  it('grille vide : erreur explicite plutôt qu’une course gratuite', () => {
    expect(() => quote({ tariff: { ...TARIFF, bands: [] } })).toThrow(
      /grille/i,
    );
  });

  it('porte la version de la grille appliquée', () => {
    expect(quote().tariffVersion).toBe(3);
  });
});

describe('quoteDelivery — subvention vendeur', () => {
  it('aucune : le client paie la base', () => {
    const q = quote();
    expect(q.subsidyXaf).toBe(0);
    expect(q.customerFeeXaf).toBe(q.baseFeeXaf);
  });

  it('montant fixe, déduit du prix client', () => {
    const q = quote({
      subsidy: { mode: 'FIXED', amountXaf: 400, thresholdXaf: null },
    });
    expect(q.subsidyXaf).toBe(400);
    expect(q.customerFeeXaf).toBe(600);
  });

  it('montant fixe plafonné au prix de base (jamais de livraison « payée » au client)', () => {
    const q = quote({
      subsidy: { mode: 'FIXED', amountXaf: 5000, thresholdXaf: null },
    });
    expect(q.subsidyXaf).toBe(1000);
    expect(q.customerFeeXaf).toBe(0);
  });

  it('offerte dès un seuil : atteint (borne incluse)', () => {
    const q = quote({
      subsidy: { mode: 'FREE_ABOVE', amountXaf: null, thresholdXaf: 5000 },
      subTotalXaf: 5000,
    });
    expect(q.customerFeeXaf).toBe(0);
    expect(q.subsidyXaf).toBe(q.baseFeeXaf);
  });

  it('offerte dès un seuil : non atteint', () => {
    const q = quote({
      subsidy: { mode: 'FREE_ABOVE', amountXaf: null, thresholdXaf: 5001 },
    });
    expect(q.subsidyXaf).toBe(0);
  });

  it('invariant : prix client + subvention = prix de base, quel que soit le réglage', () => {
    for (const amountXaf of [0, 1, 350, 999, 1000, 1001, 100_000]) {
      const q = quote({
        subsidy: { mode: 'FIXED', amountXaf, thresholdXaf: null },
      });
      expect(q.customerFeeXaf + q.subsidyXaf).toBe(q.baseFeeXaf);
      expect(q.customerFeeXaf).toBeGreaterThanOrEqual(0);
    }
  });

  it('D3 — le prix de base (assiette livreur) ne dépend jamais de la subvention', () => {
    const bases = [0, 300, 1000, 50_000].map(
      (amountXaf) =>
        quote({ subsidy: { mode: 'FIXED', amountXaf, thresholdXaf: null } })
          .baseFeeXaf,
    );
    expect(new Set(bases).size).toBe(1);
  });
});
