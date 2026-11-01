import {
  chooseOrderFlow,
  declaresAcceptFirst,
  isOrderFlow,
  paymentDeadline,
  requestExpiry,
} from './order-flow';

describe('order-flow (lot 3)', () => {
  const base = {
    platformFlow: 'ACCEPT_FIRST',
    clientDeclaresAcceptFirst: true,
    isPreorder: false,
    totalXaf: 4450,
  };

  it('ACCEPT_FIRST seulement si réglage + capacité client + immédiate + montant', () => {
    expect(chooseOrderFlow(base)).toBe('ACCEPT_FIRST');
  });

  it.each([
    ['réglage PAY_FIRST (défaut)', { platformFlow: 'PAY_FIRST' }],
    ['réglage absent', { platformFlow: null }],
    ['application qui ne l’annonce pas', { clientDeclaresAcceptFirst: false }],
    ['précommande', { isPreorder: true }],
    ['total nul (réglé en points)', { totalXaf: 0 }],
  ])('%s → PAY_FIRST', (_label, over) => {
    expect(chooseOrderFlow({ ...base, ...over })).toBe('PAY_FIRST');
  });

  it('lit la capacité, insensible à la casse et dans une liste', () => {
    expect(declaresAcceptFirst('accept-first')).toBe(true);
    expect(declaresAcceptFirst(' Accept-First ')).toBe(true);
    expect(declaresAcceptFirst('provider, accept-first')).toBe(true);
    expect(declaresAcceptFirst(['accept-first'])).toBe(true);
    expect(declaresAcceptFirst(undefined)).toBe(false);
    expect(declaresAcceptFirst('')).toBe(false);
    expect(declaresAcceptFirst('accept-first-v2')).toBe(false);
  });

  it('vocabulaire borné', () => {
    expect(isOrderFlow('PAY_FIRST')).toBe(true);
    expect(isOrderFlow('ACCEPT_FIRST')).toBe(true);
    expect(isOrderFlow('accept_first')).toBe(false);
  });

  it('échéances en minutes', () => {
    const t = new Date('2026-10-30T10:00:00Z');
    expect(requestExpiry(t, 5).toISOString()).toBe('2026-10-30T10:05:00.000Z');
    expect(paymentDeadline(t, 10).toISOString()).toBe(
      '2026-10-30T10:10:00.000Z',
    );
  });
});
