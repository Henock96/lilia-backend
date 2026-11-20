import { noShowShares } from './reservation-no-show';

describe('noShowShares — partage de l’encaissement d’une absence (J6, option D)', () => {
  it('50 % : moitié au restaurant, moitié à Lilia', () => {
    expect(noShowShares(11_500, 5_000, 9_000)).toEqual({
      vendorShareXaf: 5_750,
      platformShareXaf: 5_750,
    });
  });

  it('total impair : le franc restant va à Lilia, jamais au restaurant', () => {
    expect(noShowShares(11_501, 5_000, 9_000)).toEqual({
      vendorShareXaf: 5_750,
      platformShareXaf: 5_751,
    });
  });

  it('jamais plus que le versement normal moins un franc (aucun intérêt à mentir)', () => {
    expect(noShowShares(20_000, 9_000, 10_000)).toEqual({
      vendorShareXaf: 9_999,
      platformShareXaf: 10_001,
    });
  });

  it('versement normal nul : rien au restaurant', () => {
    expect(noShowShares(1_000, 5_000, 0)).toEqual({
      vendorShareXaf: 0,
      platformShareXaf: 1_000,
    });
  });

  it('la somme des parts vaut toujours le total', () => {
    for (const total of [0, 1, 999, 11_500, 1_234_567]) {
      for (const bps of [0, 1, 3_333, 5_000, 9_999]) {
        const s = noShowShares(total, bps, total);
        expect(s.vendorShareXaf + s.platformShareXaf).toBe(total);
        expect(s.vendorShareXaf).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it.each([
    [-1, 5_000, 0],
    [1.5, 5_000, 0],
    [1_000, 10_000, 1_000],
    [1_000, -1, 1_000],
  ])('refuse une entrée invalide (%p, %p, %p)', (total, bps, normal) => {
    expect(() => noShowShares(total, bps, normal)).toThrow();
  });
});
