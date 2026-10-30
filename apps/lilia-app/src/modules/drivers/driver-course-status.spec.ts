import { DriverCourseFacts, driverCourseStatus } from './driver-course-status';

describe('driverCourseStatus (lot 3, vue ADMIN)', () => {
  const base: DriverCourseFacts = {
    deliveryStatus: 'LIVRER',
    orderStatus: 'LIVRER',
    failureLiability: null,
    economicsFrozen: true,
    settlementStatus: null,
  };
  const s = (over: Partial<DriverCourseFacts>) =>
    driverCourseStatus({ ...base, ...over });

  it('livrée, paie figée, non réglée → à recevoir', () => {
    expect(s({})).toBe('PAYABLE');
  });

  it('rattachée à un règlement PAID → réglée', () => {
    expect(s({ settlementStatus: 'PAID' })).toBe('SETTLED');
  });

  it('règlement annulé : redevient à recevoir', () => {
    expect(s({ settlementStatus: 'CANCELLED' })).toBe('PAYABLE');
  });

  it('livrée sans économie figée → montant inconnu, jamais inventé', () => {
    expect(s({ economicsFrozen: false })).toBe('UNKNOWN_PAY');
  });

  it('échec déclaré, pas encore arbitré → en litige', () => {
    expect(s({ deliveryStatus: 'ECHEC', orderStatus: 'EN_ROUTE' })).toBe(
      'DISPUTED',
    );
  });

  it('échec imputé au livreur → retenue', () => {
    expect(
      s({
        deliveryStatus: 'ECHEC',
        orderStatus: 'ECHEC_LIVRAISON',
        failureLiability: 'DRIVER',
      }),
    ).toBe('RETAINED');
  });

  it.each(['CLIENT', 'VENDOR', 'PLATFORM'])(
    'échec sans faute du livreur (%s) → à recevoir, comme payableWhere',
    (liability) => {
      expect(
        s({
          deliveryStatus: 'ECHEC',
          orderStatus: 'ECHEC_LIVRAISON',
          failureLiability: liability,
        }),
      ).toBe('PAYABLE');
    },
  );

  it('course en cours', () => {
    expect(s({ deliveryStatus: 'ACCEPTER', orderStatus: 'EN_ROUTE' })).toBe(
      'IN_PROGRESS',
    );
  });
});
