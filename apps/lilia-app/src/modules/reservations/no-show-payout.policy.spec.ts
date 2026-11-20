import {
  assertNoShowPayoutAccountUsable,
  noShowPayoutApprovalPayload,
  noShowPayoutState,
  sameNoShowPayoutPayload,
} from './no-show-payout.policy';

/** 4B-2 J6b — règles pures du versement de la part restaurant d'une absence. */
describe('Versement de la part d’absence — règles', () => {
  const NOW = new Date('2026-11-20T10:00:00Z');
  const HOUR = 3_600_000;
  const account = {
    payoutPhoneNumber: '242060000080',
    payoutProvider: 'MTN_MOMO' as const,
    payoutVerifiedAt: new Date(NOW.getTime() - 48 * HOUR),
  };

  const codeOf = (fn: () => void) => {
    try {
      fn();
      return null;
    } catch (e) {
      return (e as { getResponse: () => { code: string } }).getResponse().code;
    }
  };

  describe('compte de versement (P-2)', () => {
    it('compte complet, vérifié, hors carence, sans changement en attente : utilisable', () => {
      expect(
        codeOf(() => assertNoShowPayoutAccountUsable(account, NOW, false)),
      ).toBeNull();
    });

    it('numéro ou opérateur absent : refusé', () => {
      expect(
        codeOf(() =>
          assertNoShowPayoutAccountUsable(
            { ...account, payoutPhoneNumber: null },
            NOW,
            false,
          ),
        ),
      ).toBe('NO_SHOW_PAYOUT_ACCOUNT_MISSING');
      expect(
        codeOf(() =>
          assertNoShowPayoutAccountUsable(
            { ...account, payoutProvider: null },
            NOW,
            false,
          ),
        ),
      ).toBe('NO_SHOW_PAYOUT_ACCOUNT_MISSING');
    });

    it('compte jamais vérifié par un administrateur : refusé (plus strict que le reversement)', () => {
      expect(
        codeOf(() =>
          assertNoShowPayoutAccountUsable(
            { ...account, payoutVerifiedAt: null },
            NOW,
            false,
          ),
        ),
      ).toBe('NO_SHOW_PAYOUT_ACCOUNT_UNVERIFIED');
    });

    it('compte modifié il y a moins de 24 h : carence', () => {
      expect(
        codeOf(() =>
          assertNoShowPayoutAccountUsable(
            { ...account, payoutVerifiedAt: new Date(NOW.getTime() - HOUR) },
            NOW,
            false,
          ),
        ),
      ).toBe('VENDOR_PAYOUT_ACCOUNT_COOLING_DOWN');
    });

    it('changement de compte en attente d’approbation : refusé', () => {
      expect(
        codeOf(() => assertNoShowPayoutAccountUsable(account, NOW, true)),
      ).toBe('NO_SHOW_PAYOUT_ACCOUNT_CHANGE_PENDING');
    });
  });

  describe('charge utile d’approbation', () => {
    const settlement = { id: 'set-1', vendorShareXaf: 4_250 };

    it('porte l’absence, le montant, le numéro et l’opérateur — ce que le valideur approuve', () => {
      expect(noShowPayoutApprovalPayload(settlement, account)).toEqual({
        settlementId: 'set-1',
        amountXaf: 4_250,
        phoneNumber: '242060000080',
        payoutProvider: 'MTN_MOMO',
      });
    });

    it('un autre numéro ou un autre opérateur n’est pas le même geste', () => {
      const approved = noShowPayoutApprovalPayload(settlement, account);
      expect(sameNoShowPayoutPayload(approved, { ...approved })).toBe(true);
      expect(
        sameNoShowPayoutPayload(approved, {
          ...approved,
          phoneNumber: '242069999999',
        }),
      ).toBe(false);
      expect(
        sameNoShowPayoutPayload(approved, {
          ...approved,
          payoutProvider: 'AIRTEL_MONEY',
        }),
      ).toBe(false);
      expect(
        sameNoShowPayoutPayload(approved, { ...approved, amountXaf: 4_251 }),
      ).toBe(false);
    });
  });

  describe('état d’une absence (B-3)', () => {
    it('part nulle : rien à verser', () => {
      expect(noShowPayoutState(0, [])).toBe('NOTHING_DUE');
    });
    it('aucun versement, ou seulement des échecs : à verser', () => {
      expect(noShowPayoutState(4_250, [])).toBe('DUE');
      expect(noShowPayoutState(4_250, ['FAILED', 'FAILED'])).toBe('DUE');
    });
    it('un versement en vol : en cours', () => {
      expect(noShowPayoutState(4_250, ['FAILED', 'PENDING'])).toBe(
        'IN_PROGRESS',
      );
    });
    it('un versement abouti : versé', () => {
      expect(noShowPayoutState(4_250, ['FAILED', 'SUCCESS'])).toBe('PAID');
    });
  });
});
