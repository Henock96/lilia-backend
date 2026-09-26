import {
  capOfferToVendorNet,
  offerDiscountXaf,
  offerLabel,
  OfferTermsError,
  assertOfferTerms,
  VENDOR_OFFER_MAX_DAYS,
} from './vendor-offer-pricing';

const percent = (value: number, maxDiscountXaf: number | null = null) => ({
  kind: 'PERCENT' as const,
  value,
  minSubTotalXaf: 0,
  maxDiscountXaf,
});
const threshold = (value: number, minSubTotalXaf: number) => ({
  kind: 'FIXED_THRESHOLD' as const,
  value,
  minSubTotalXaf,
  maxDiscountXaf: null,
});

describe('offerDiscountXaf', () => {
  it('PERCENT : pourcentage du sous-total, arrondi à l’entier', () => {
    expect(offerDiscountXaf(percent(10), 5_000)).toBe(500);
    expect(offerDiscountXaf(percent(15), 3_333)).toBe(500); // 499,95
  });

  it('PERCENT : plafonné par maxDiscountXaf', () => {
    expect(offerDiscountXaf(percent(20, 1_000), 10_000)).toBe(1_000);
  });

  it('PERCENT : respecte le seuil minimal s’il est posé', () => {
    const offer = { ...percent(10), minSubTotalXaf: 4_000 };
    expect(offerDiscountXaf(offer, 3_999)).toBe(0);
    expect(offerDiscountXaf(offer, 4_000)).toBe(400);
  });

  it('FIXED_THRESHOLD : rien sous le seuil, le montant dès le seuil', () => {
    expect(offerDiscountXaf(threshold(500, 5_000), 4_999)).toBe(0);
    expect(offerDiscountXaf(threshold(500, 5_000), 5_000)).toBe(500);
  });

  it('ne dépasse jamais le sous-total', () => {
    expect(offerDiscountXaf(percent(50), 1)).toBeLessThanOrEqual(1);
  });

  it('panier vide ⇒ 0', () => {
    expect(offerDiscountXaf(percent(10), 0)).toBe(0);
  });
});

describe('capOfferToVendorNet — le reversement ne descend jamais sous 0', () => {
  it('laisse passer une remise couverte par le net vendeur', () => {
    expect(
      capOfferToVendorNet(500, {
        subTotalXaf: 5_000,
        commissionAmountXaf: 500,
        vendorDeliverySubsidyXaf: 0,
      }),
    ).toBe(500);
  });

  it('réduit la remise au net vendeur (−50 % sur un vendeur à 50 % de commission)', () => {
    expect(
      capOfferToVendorNet(2_500, {
        subTotalXaf: 5_000,
        commissionAmountXaf: 2_500,
        vendorDeliverySubsidyXaf: 500,
      }),
    ).toBe(2_000);
  });

  it('jamais négatif', () => {
    expect(
      capOfferToVendorNet(100, {
        subTotalXaf: 1_000,
        commissionAmountXaf: 600,
        vendorDeliverySubsidyXaf: 600,
      }),
    ).toBe(0);
  });
});

describe('offerLabel', () => {
  // `toLocaleString('fr-FR')` groupe par une espace fine insécable.
  const norm = (s: string) => s.replace(/\s/g, ' ');
  it('décrit l’offre en français, montants groupés', () => {
    expect(norm(offerLabel(percent(10)))).toBe('−10 % sur toute la boutique');
    expect(norm(offerLabel(percent(10, 1_000)))).toBe(
      '−10 % sur toute la boutique (jusqu’à 1 000 FCFA)',
    );
    expect(norm(offerLabel(threshold(500, 5_000)))).toBe(
      '−500 FCFA dès 5 000 FCFA d’achat',
    );
  });
});

describe('assertOfferTerms — bornes vendeur (Q2 : hors bornes = refus)', () => {
  const now = new Date('2026-09-26T10:00:00Z');
  const in14Days = new Date('2026-10-10T10:00:00Z');
  const base: {
    kind: 'PERCENT' | 'FIXED_THRESHOLD';
    value: number;
    minSubTotalXaf: number;
    maxDiscountXaf: number | null;
    startsAt: Date;
    endsAt: Date;
    budgetXaf: number;
  } = {
    kind: 'PERCENT',
    value: 10,
    minSubTotalXaf: 0,
    maxDiscountXaf: null,
    startsAt: now,
    endsAt: in14Days,
    budgetXaf: 20_000,
  };
  const codeOf = (terms: Partial<typeof base> & Record<string, unknown>) => {
    try {
      assertOfferTerms({ ...base, ...terms } as never, now);
      return null;
    } catch (err) {
      expect(err).toBeInstanceOf(OfferTermsError);
      return (err as OfferTermsError).code;
    }
  };

  it('accepte une offre dans les bornes', () => {
    expect(codeOf({})).toBeNull();
  });

  it('refuse plus de 50 %', () => {
    expect(codeOf({ value: 51 })).toBe('OFFER_PERCENT_OUT_OF_RANGE');
    expect(codeOf({ value: 0 })).toBe('OFFER_PERCENT_OUT_OF_RANGE');
  });

  it('refuse une durée de plus de 30 jours', () => {
    const tooLong = new Date(
      now.getTime() + (VENDOR_OFFER_MAX_DAYS * 24 + 1) * 3_600_000,
    );
    expect(codeOf({ endsAt: tooLong })).toBe('OFFER_TOO_LONG');
  });

  it('refuse une échéance passée ou avant le début', () => {
    expect(codeOf({ endsAt: now })).toBe('OFFER_WINDOW_INVALID');
  });

  it('refuse un budget nul', () => {
    expect(codeOf({ budgetXaf: 0 })).toBe('OFFER_BUDGET_REQUIRED');
  });

  it('FIXED_THRESHOLD : le seuil doit dépasser la remise', () => {
    expect(
      codeOf({ kind: 'FIXED_THRESHOLD', value: 500, minSubTotalXaf: 500 }),
    ).toBe('OFFER_THRESHOLD_INVALID');
    expect(
      codeOf({ kind: 'FIXED_THRESHOLD', value: 500, minSubTotalXaf: 5_000 }),
    ).toBeNull();
  });

  it('FIXED_THRESHOLD : la remise ne dépasse pas la moitié du seuil (même borne que 50 %)', () => {
    expect(
      codeOf({ kind: 'FIXED_THRESHOLD', value: 3_000, minSubTotalXaf: 5_000 }),
    ).toBe('OFFER_THRESHOLD_INVALID');
  });

  it('refuse un plafond sur une remise fixe', () => {
    expect(
      codeOf({
        kind: 'FIXED_THRESHOLD',
        value: 500,
        minSubTotalXaf: 5_000,
        maxDiscountXaf: 400,
      }),
    ).toBe('OFFER_THRESHOLD_INVALID');
  });

  it('refuse un budget inférieur à une seule remise', () => {
    expect(
      codeOf({
        kind: 'FIXED_THRESHOLD',
        value: 500,
        minSubTotalXaf: 5_000,
        budgetXaf: 499,
      }),
    ).toBe('OFFER_BUDGET_TOO_SMALL');
  });
});
