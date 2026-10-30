import { ROLE_PERMISSIONS, roleGrants } from './shop-access';

/**
 * Lot 3 (point 7) — table des permissions par rôle, celle de l'audit §6.5.
 * La changer est une décision : ce test le rend visible.
 */
describe('ShopMembership — permissions par rôle', () => {
  it('OWNER : tout, dont versements et membres', () => {
    expect([...ROLE_PERMISSIONS.OWNER].sort()).toEqual(
      ['CATALOG', 'MEMBERS', 'ORDERS', 'PAYOUTS', 'SETTINGS', 'STOCK'].sort(),
    );
  });

  it('MANAGER : commandes, catalogue, stock, réglages — ni versements ni membres', () => {
    expect(roleGrants('MANAGER', 'ORDERS')).toBe(true);
    expect(roleGrants('MANAGER', 'SETTINGS')).toBe(true);
    expect(roleGrants('MANAGER', 'PAYOUTS')).toBe(false);
    expect(roleGrants('MANAGER', 'MEMBERS')).toBe(false);
  });

  it('STAFF : commandes et stock seulement', () => {
    expect([...ROLE_PERMISSIONS.STAFF].sort()).toEqual(['ORDERS', 'STOCK']);
    expect(roleGrants('STAFF', 'CATALOG')).toBe(false);
  });

  it('rôle inconnu : rien', () => {
    expect(roleGrants('PIRATE', 'ORDERS')).toBe(false);
  });
});
