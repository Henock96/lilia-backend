import { orderPaymentAllowed } from './order-payment-policy';

describe('orderPaymentAllowed', () => {
  const now = new Date('2026-11-01T12:00:00Z');
  const accepted = {
    status: 'EN_ATTENTE',
    orderFlow: 'ACCEPT_FIRST',
    acceptedAt: new Date(now.getTime() - 1000),
  };
  it.each([
    'DEMANDE_ENVOYEE',
    'ACCEPTEE',
    'PAYER',
    'EN_PREPARATION',
    'PRET',
    'EN_ROUTE',
    'LIVRER',
    'ANNULER',
    'ECHEC_LIVRAISON',
  ])('refuse %s', (status) => {
    expect(orderPaymentAllowed({ ...accepted, status }, now)).toBe(false);
  });
  it('exige une acceptation et une fenêtre encore ouverte', () => {
    expect(orderPaymentAllowed({ ...accepted, acceptedAt: null }, now)).toBe(
      false,
    );
    expect(orderPaymentAllowed({ ...accepted, paymentDueAt: now }, now)).toBe(
      false,
    );
    expect(
      orderPaymentAllowed(
        { ...accepted, paymentDueAt: new Date(now.getTime() + 1) },
        now,
      ),
    ).toBe(true);
  });
  it('préserve EN_ATTENTE historique sans acceptation', () => {
    expect(
      orderPaymentAllowed(
        { status: 'EN_ATTENTE', orderFlow: 'PAY_FIRST' },
        now,
      ),
    ).toBe(true);
  });
});
