import { quoteFingerprint } from './quote-fingerprint';

describe('quoteFingerprint', () => {
  it('canonicalise les clés et dates, avec une version explicite', () => {
    const a = quoteFingerprint({
      total: 1500,
      choice: { delivery: true, date: new Date('2026-11-01T00:00:00Z') },
    });
    const b = quoteFingerprint({
      choice: { date: '2026-11-01T00:00:00.000Z', delivery: true },
      total: 1500,
    });
    expect(a).toBe(b);
    expect(a).toMatch(/^v1:[a-f0-9]{64}$/);
  });

  it.each(['items', 'options', 'destination', 'loyalty', 'fees'])(
    'détecte %s même à total inchangé',
    (field) => {
      expect(quoteFingerprint({ total: 1500, [field]: 'A' })).not.toBe(
        quoteFingerprint({ total: 1500, [field]: 'B' }),
      );
    },
  );
});
