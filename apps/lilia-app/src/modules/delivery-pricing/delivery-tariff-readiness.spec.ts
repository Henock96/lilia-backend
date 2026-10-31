import { tariffReadiness } from './delivery-tariff-readiness';

/**
 * Préparation de la bascule `PLATFORM` (lot 4) — même ordre de décision que
 * `quoteDelivery` : prix fixe, puis tranche, puis repli.
 */
describe('tariffReadiness', () => {
  const quartiers = [
    { id: 'q-poto', nom: 'Poto-Poto', hasCentroid: true },
    { id: 'q-baco', nom: 'Bacongo', hasCentroid: true },
    { id: 'q-mfil', nom: 'Mfilou', hasCentroid: false },
  ];
  const vendor = (over: Record<string, unknown> = {}) => ({
    id: 'v1',
    nom: 'Chez Awa',
    quartierId: 'q-poto',
    hasGps: false,
    ...over,
  });

  it('grille complète en prix fixes : prête, aucun couple manquant', () => {
    const overrides = quartiers.map((q) => ({
      originQuartierId: 'q-poto',
      destQuartierId: q.id,
    }));
    const r = tariffReadiness({
      quartiers,
      vendors: [vendor()],
      tariff: { bandsCount: 0, overrides },
    });

    expect(r.ready).toBe(true);
    expect(r.counts).toEqual({ OVERRIDE: 3, BAND: 0, FALLBACK: 0, pairs: 3 });
    expect(r.missingOverrides).toEqual([]);
  });

  it('sans prix fixe, les tranches chiffrent les couples positionnés ; le quartier sans centroïde tombe au repli', () => {
    const r = tariffReadiness({
      quartiers,
      vendors: [vendor()],
      tariff: { bandsCount: 3, overrides: [] },
    });

    expect(r.counts).toMatchObject({ BAND: 2, FALLBACK: 1 });
    expect(r.ready).toBe(false);
    expect(r.missingOverrides).toContainEqual({
      originQuartierId: 'q-poto',
      destQuartierId: 'q-mfil',
      basis: 'FALLBACK',
    });
    expect(r.quartiersWithoutCentroid).toEqual([
      { id: 'q-mfil', nom: 'Mfilou' },
    ]);
  });

  it('un prix fixe vers le quartier sans centroïde suffit à le rendre prêt', () => {
    const r = tariffReadiness({
      quartiers,
      vendors: [vendor()],
      tariff: {
        bandsCount: 3,
        overrides: [{ originQuartierId: 'q-poto', destQuartierId: 'q-mfil' }],
      },
    });

    expect(r.ready).toBe(true);
    expect(r.counts).toMatchObject({ OVERRIDE: 1, BAND: 2, FALLBACK: 0 });
  });

  it('un vendeur sans quartier bloque la bascule', () => {
    const r = tariffReadiness({
      quartiers,
      vendors: [
        vendor(),
        vendor({ id: 'v2', nom: 'Sans adresse', quartierId: null }),
      ],
      tariff: {
        bandsCount: 3,
        overrides: [{ originQuartierId: 'q-poto', destQuartierId: 'q-mfil' }],
      },
    });

    expect(r.ready).toBe(false);
    expect(r.vendorsWithoutQuartier).toEqual([
      { id: 'v2', nom: 'Sans adresse' },
    ]);
  });

  it('origine sans centroïde : les tranches ne valent que si tous ses vendeurs ont un GPS', () => {
    const avecGps = tariffReadiness({
      quartiers,
      vendors: [vendor({ quartierId: 'q-mfil', hasGps: true })],
      tariff: { bandsCount: 3, overrides: [] },
    });
    // Vers Mfilou lui-même : destination sans centroïde → repli.
    expect(avecGps.counts).toMatchObject({ BAND: 2, FALLBACK: 1 });

    const unSansGps = tariffReadiness({
      quartiers,
      vendors: [
        vendor({ quartierId: 'q-mfil', hasGps: true }),
        vendor({ id: 'v2', quartierId: 'q-mfil', hasGps: false }),
      ],
      tariff: { bandsCount: 3, overrides: [] },
    });
    expect(unSansGps.counts).toMatchObject({ BAND: 0, FALLBACK: 3 });
  });

  it('aucun vendeur visible : rien n’est évalué, donc pas prête', () => {
    const r = tariffReadiness({
      quartiers,
      vendors: [],
      tariff: { bandsCount: 3, overrides: [] },
    });

    expect(r.counts.pairs).toBe(0);
    expect(r.ready).toBe(false);
  });

  it('les origines sont les quartiers des vendeurs, chacun compté une fois', () => {
    const r = tariffReadiness({
      quartiers,
      vendors: [
        vendor(),
        vendor({ id: 'v2' }),
        vendor({ id: 'v3', quartierId: 'q-baco' }),
      ],
      tariff: { bandsCount: 3, overrides: [] },
    });

    expect(r.counts.pairs).toBe(6);
  });
});
