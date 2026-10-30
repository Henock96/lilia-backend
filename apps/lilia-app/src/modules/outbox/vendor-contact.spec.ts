import { orderPaidReminderAt, pickEscalationPhone } from './vendor-contact';

describe('pickEscalationPhone (F-02)', () => {
  it('préfère le mobile du compte', () => {
    expect(
      pickEscalationPhone({
        ownerPhone: '06 111 22 33',
        shopPhone: '055554433',
      }),
    ).toEqual({ phone: '061112233', source: 'OWNER' });
  });

  it('retombe sur la boutique quand le compte n’a pas de numéro', () => {
    expect(
      pickEscalationPhone({ ownerPhone: null, shopPhone: '+242 05 555 44 33' }),
    ).toEqual({ phone: '+242055554433', source: 'SHOP' });
  });

  it('retombe sur la boutique quand le numéro du compte n’est pas un mobile', () => {
    expect(
      pickEscalationPhone({ ownerPhone: '12', shopPhone: '044443322' }),
    ).toEqual({ phone: '044443322', source: 'SHOP' });
  });

  it('aucun mobile exploitable : null', () => {
    expect(
      pickEscalationPhone({
        ownerPhone: undefined,
        shopPhone: '0222 81 00 00',
      }),
    ).toBeNull();
  });
});

describe('orderPaidReminderAt', () => {
  const paidAt = new Date('2026-10-29T10:00:00Z');

  it('sans échéance : paiement + 10 min', () => {
    expect(
      orderPaidReminderAt({ paidAt, acceptDeadlineAt: null, leadMinutes: 3 }),
    ).toEqual(new Date('2026-10-29T10:10:00Z'));
  });

  it('avec échéance : échéance − lead', () => {
    expect(
      orderPaidReminderAt({
        paidAt,
        acceptDeadlineAt: new Date('2026-10-29T10:08:00Z'),
        leadMinutes: 3,
      }),
    ).toEqual(new Date('2026-10-29T10:05:00Z'));
  });
});
