import {
  hasEntitlement,
  isPeriodActive,
  subscriptionVerdict,
} from './entitlements';

describe('entitlements — seule définition de « abonné »', () => {
  const t = (iso: string) => new Date(iso);
  const period = (
    over: Partial<Parameters<typeof isPeriodActive>[0]> = {},
  ) => ({
    plan: 'PREMIUM',
    status: 'ACTIVE',
    startsAt: t('2026-10-11T09:00:00Z'),
    endsAt: t('2026-11-11T09:00:00Z'),
    ...over,
  });

  describe('isPeriodActive', () => {
    it('pendant la période : actif', () => {
      expect(isPeriodActive(period(), t('2026-10-20T00:00:00Z'))).toBe(true);
    });
    it('au premier instant : actif (début inclus)', () => {
      expect(isPeriodActive(period(), t('2026-10-11T09:00:00Z'))).toBe(true);
    });
    it('à la fin exacte : expiré (fin exclue)', () => {
      expect(isPeriodActive(period(), t('2026-11-11T09:00:00Z'))).toBe(false);
    });
    it('pas encore commencée (prolongation empilée) : non actif', () => {
      expect(isPeriodActive(period(), t('2026-10-01T00:00:00Z'))).toBe(false);
    });
    it('révoquée : non actif, même en pleine période', () => {
      expect(
        isPeriodActive(
          period({ status: 'REVOKED' }),
          t('2026-10-20T00:00:00Z'),
        ),
      ).toBe(false);
    });
  });

  describe('subscriptionVerdict', () => {
    const now = t('2026-10-20T00:00:00Z');

    it('Standard : aucun droit', () => {
      const v = subscriptionVerdict([], now);
      expect(v).toEqual({
        plan: null,
        active: false,
        currentPeriodEndsAt: null,
        paidUntil: null,
        entitlements: [],
      });
      expect(hasEntitlement(v, 'ANALYTICS_ADVANCED')).toBe(false);
    });

    it('Premium actif : les deux droits, fin de période et payé jusqu’au', () => {
      const v = subscriptionVerdict([period()], now);
      expect(v.active).toBe(true);
      expect(v.plan).toBe('PREMIUM');
      expect(v.entitlements).toEqual([
        'ANALYTICS_ADVANCED',
        'ON_SITE_RESERVATIONS',
      ]);
      expect(v.currentPeriodEndsAt).toEqual(t('2026-11-11T09:00:00Z'));
      expect(v.paidUntil).toEqual(t('2026-11-11T09:00:00Z'));
      expect(hasEntitlement(v, 'ON_SITE_RESERVATIONS')).toBe(true);
    });

    it('prolongation empilée : la période courante décide, payé jusqu’à la dernière', () => {
      const next = period({
        startsAt: t('2026-11-11T09:00:00Z'),
        endsAt: t('2026-12-11T09:00:00Z'),
      });
      const v = subscriptionVerdict([next, period()], now);
      expect(v.currentPeriodEndsAt).toEqual(t('2026-11-11T09:00:00Z'));
      expect(v.paidUntil).toEqual(t('2026-12-11T09:00:00Z'));
    });

    it('expiré : redevient Standard tout seul, sans cron', () => {
      const v = subscriptionVerdict([period()], t('2026-12-01T00:00:00Z'));
      expect(v.active).toBe(false);
      expect(v.entitlements).toEqual([]);
      expect(v.paidUntil).toBeNull();
    });

    it('révoqué : aucun droit, et la période ne compte pas comme payée', () => {
      const v = subscriptionVerdict([period({ status: 'REVOKED' })], now);
      expect(v.active).toBe(false);
      expect(v.paidUntil).toBeNull();
    });
  });
});
