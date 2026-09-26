import {
  activeOfferRelationSelect,
  withActiveOffer,
} from './vendor-offer-projection';

describe('Projection publique de l’offre boutique (F3-11)', () => {
  const offerRow = {
    id: 'o1',
    kind: 'PERCENT' as const,
    value: 10,
    minSubTotalXaf: 0,
    maxDiscountXaf: null,
    endsAt: new Date('2026-10-10T10:00:00Z'),
  };

  it('ne sélectionne jamais le budget ni la consommation d’un vendeur', () => {
    const select = activeOfferRelationSelect(new Date()).vendorOffers.select;
    expect(Object.keys(select).sort()).toEqual(
      [
        'endsAt',
        'id',
        'kind',
        'maxDiscountXaf',
        'minSubTotalXaf',
        'value',
      ].sort(),
    );
    expect(select).not.toHaveProperty('budgetXaf');
    expect(select).not.toHaveProperty('spentXaf');
  });

  it('ne retient que les offres ACTIVE, commencées et non échues', () => {
    const now = new Date('2026-09-26T10:00:00Z');
    expect(activeOfferRelationSelect(now).vendorOffers.where).toEqual({
      status: 'ACTIVE',
      startsAt: { lte: now },
      endsAt: { gt: now },
    });
  });

  it('remplace la relation par `activeOffer`, libellé compris', () => {
    const out = withActiveOffer({ id: 'v1', vendorOffers: [offerRow] }, true);
    expect(out).not.toHaveProperty('vendorOffers');
    expect(out.activeOffer).toMatchObject({ id: 'o1', value: 10 });
    expect(out.activeOffer?.label).toContain('−10 %');
  });

  it('interrupteur éteint : `activeOffer` toujours null', () => {
    const out = withActiveOffer({ id: 'v1', vendorOffers: [offerRow] }, false);
    expect(out.activeOffer).toBeNull();
    expect(out).not.toHaveProperty('vendorOffers');
  });

  it('aucune offre : null', () => {
    expect(
      withActiveOffer({ id: 'v1', vendorOffers: [] }, true).activeOffer,
    ).toBeNull();
  });
});
