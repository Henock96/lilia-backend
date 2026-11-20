import { isReservable } from './reservation-bookable';

describe('isReservable (4C-0, D-1)', () => {
  const ok = {
    vendorType: 'RESTAURANT',
    platformEnabled: true,
    settingsEnabled: true,
    entitled: true,
  };

  it('restaurant Premium, activé, plateforme allumée : réservable', () => {
    expect(isReservable(ok)).toBe(true);
  });

  it.each([
    ['type de vendeur non éligible', { vendorType: 'BAKERY' }],
    ['interrupteur plateforme éteint', { platformEnabled: false }],
    ['réservations désactivées par le restaurant', { settingsEnabled: false }],
    ['Premium absent ou expiré', { entitled: false }],
  ])('%s : non réservable', (_label, patch) => {
    expect(isReservable({ ...ok, ...patch })).toBe(false);
  });
});
