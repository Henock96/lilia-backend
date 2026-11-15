import {
  orderMargin,
  resolveProviderFee,
  summarizeMargins,
} from './order-margin';

describe('resolveProviderFee', () => {
  it('la valeur réelle prime sur le taux du contrat', () => {
    expect(resolveProviderFee(120, 10_000, 200)).toEqual({
      amountXaf: 120,
      quality: 'CONFIRMED',
    });
  });

  it('un frais réel de 0 reste confirmé, pas inconnu', () => {
    expect(resolveProviderFee(0, 10_000, null)).toEqual({
      amountXaf: 0,
      quality: 'CONFIRMED',
    });
  });

  it('sans valeur réelle : taux en points de base, arrondi au franc', () => {
    // 6 250 × 1,75 % = 109,375 → 109.
    expect(resolveProviderFee(null, 6_250, 175)).toEqual({
      amountXaf: 109,
      quality: 'ESTIMATED',
    });
  });

  it('sans taux : inconnu, jamais 0', () => {
    expect(resolveProviderFee(null, 6_250, null)).toEqual({
      amountXaf: null,
      quality: 'UNKNOWN',
    });
  });
});

describe('orderMargin', () => {
  const confirmed = (amountXaf: number) =>
    ({ amountXaf, quality: 'CONFIRMED' }) as const;
  const estimated = (amountXaf: number) =>
    ({ amountXaf, quality: 'ESTIMATED' }) as const;
  const unknown = { amountXaf: null, quality: 'UNKNOWN' } as const;

  it('tous les postes réels : marge confirmée', () => {
    const m = orderMargin({
      marginBeforeProviderFeesXaf: 1_000,
      collectionFee: confirmed(100),
      payoutFee: confirmed(50),
    });
    expect(m.marginXaf).toBe(850);
    expect(m.quality).toBe('CONFIRMED');
  });

  it('un poste estimé : la marge entière est estimée', () => {
    const m = orderMargin({
      marginBeforeProviderFeesXaf: 1_000,
      collectionFee: confirmed(100),
      payoutFee: estimated(50),
    });
    expect(m.marginXaf).toBe(850);
    expect(m.quality).toBe('ESTIMATED');
  });

  it('un poste inconnu : pas de marge', () => {
    const m = orderMargin({
      marginBeforeProviderFeesXaf: 1_000,
      collectionFee: unknown,
      payoutFee: confirmed(50),
    });
    expect(m.marginXaf).toBeNull();
    expect(m.quality).toBe('UNKNOWN');
  });

  it('coût livreur inconnu : pas de marge, même avec des frais connus', () => {
    const m = orderMargin({
      marginBeforeProviderFeesXaf: null,
      collectionFee: confirmed(100),
      payoutFee: confirmed(50),
    });
    expect(m.marginXaf).toBeNull();
    expect(m.quality).toBe('UNKNOWN');
  });

  it('une marge négative reste une marge', () => {
    const m = orderMargin({
      marginBeforeProviderFeesXaf: 100,
      collectionFee: confirmed(100),
      payoutFee: confirmed(50),
    });
    expect(m.marginXaf).toBe(-50);
  });
});

describe('summarizeMargins', () => {
  it('compte par qualité et ne somme que les marges connues', () => {
    const s = summarizeMargins([
      { marginXaf: 800, quality: 'CONFIRMED' },
      { marginXaf: -200, quality: 'ESTIMATED' },
      { marginXaf: null, quality: 'UNKNOWN' },
    ]);
    expect(s).toEqual({
      orders: 3,
      byQuality: { CONFIRMED: 1, ESTIMATED: 1, UNKNOWN: 1 },
      knownMarginXaf: 600,
    });
  });

  it('aucune commande : zéro partout', () => {
    expect(summarizeMargins([]).knownMarginXaf).toBe(0);
  });
});
