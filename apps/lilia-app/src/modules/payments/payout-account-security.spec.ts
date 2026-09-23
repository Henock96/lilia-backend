import {
  payoutAccountCooldownHours,
  payoutAccountCoolingUntil,
} from './services/restaurant-payout.service';
import { hasProvenIdentity } from '../admin/admin.controller';

/**
 * F-08 / F-09 (Master Audit v1) — un compte administrateur compromis ne doit
 * pas pouvoir détourner un reversement, ni faire d'un inconnu un vendeur.
 */
describe('délai de carence du compte de reversement (F-08)', () => {
  const now = new Date('2026-09-23T12:00:00Z');
  const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000);
  const saved = process.env.PAYOUT_ACCOUNT_COOLDOWN_HOURS;
  afterEach(() => {
    if (saved === undefined) delete process.env.PAYOUT_ACCOUNT_COOLDOWN_HOURS;
    else process.env.PAYOUT_ACCOUNT_COOLDOWN_HOURS = saved;
  });

  it('24 h par défaut', () => {
    delete process.env.PAYOUT_ACCOUNT_COOLDOWN_HOURS;
    expect(payoutAccountCooldownHours()).toBe(24);
  });

  it('numéro changé il y a 2 h : bloqué jusqu’à changement + 24 h', () => {
    delete process.env.PAYOUT_ACCOUNT_COOLDOWN_HOURS;
    expect(payoutAccountCoolingUntil(hoursAgo(2), now)).toEqual(
      new Date(hoursAgo(2).getTime() + 24 * 3_600_000),
    );
  });

  it('numéro changé il y a 25 h : libre', () => {
    delete process.env.PAYOUT_ACCOUNT_COOLDOWN_HOURS;
    expect(payoutAccountCoolingUntil(hoursAgo(25), now)).toBeNull();
  });

  it('compte jamais horodaté (antérieur au dispositif) : pas bloqué', () => {
    expect(payoutAccountCoolingUntil(null, now)).toBeNull();
  });

  it('0 désactive le délai ; une valeur absurde retombe sur 24', () => {
    process.env.PAYOUT_ACCOUNT_COOLDOWN_HOURS = '0';
    expect(payoutAccountCoolingUntil(hoursAgo(1), now)).toBeNull();
    process.env.PAYOUT_ACCOUNT_COOLDOWN_HOURS = 'abc';
    expect(payoutAccountCooldownHours()).toBe(24);
  });
});

describe('identité prouvée avant promotion (F-09)', () => {
  it.each([
    [{ emailVerified: true, providers: ['password'] }, true],
    [{ emailVerified: false, providers: ['google.com'] }, true],
    [{ emailVerified: false, providers: ['apple.com'] }, true],
    // Le cas du squat : e-mail/mot de passe jamais vérifié.
    [{ emailVerified: false, providers: ['password'] }, false],
    [null, false],
  ])('%j → %s', (evidence, expected) => {
    expect(hasProvenIdentity(evidence)).toBe(expected);
  });
});
