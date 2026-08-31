import {
  applyBasisPoints,
  computePayoutBreakdown,
  MAX_COMMISSION_PERCENT,
  percentToBasisPoints,
  toXaf,
} from './money.util';

/**
 * Calculs financiers du reversement vendeur.
 *
 * Ces tests sont les seuls garants de ce que touche réellement un commerçant.
 * Un écart d'un franc n'est pas une coquille : c'est un vendeur qui recompte et
 * qui appelle.
 */
describe('money.util — arithmétique du reversement', () => {
  describe('computePayoutBreakdown — le cas de référence', () => {
    it('5 000 F à 10 % → commission 500, reversement 4 500', () => {
      const result = computePayoutBreakdown({
        subTotalXaf: 5000,
        commissionPercent: 10,
      });

      expect(result).toEqual({
        grossAmount: 5000,
        commissionPercent: 10,
        commissionAmount: 500,
        payoutAmount: 4500,
      });
    });

    it.each([
      // [sous-total, taux, commission attendue, reversement attendu]
      [5000, 8, 400, 4600],
      [5000, 10, 500, 4500],
      [5000, 12, 600, 4400],
      [5000, 15, 750, 4250],
      [10000, 10, 1000, 9000],
      [1000, 12, 120, 880],
      [100, 15, 15, 85],
    ])(
      'sous-total %i F à %i %% → commission %i F, reversement %i F',
      (subTotal, percent, commission, payout) => {
        const result = computePayoutBreakdown({
          subTotalXaf: subTotal,
          commissionPercent: percent,
        });
        expect(result.commissionAmount).toBe(commission);
        expect(result.payoutAmount).toBe(payout);
      },
    );

    it('commission + reversement = brut, toujours (aucun franc perdu)', () => {
      // Balayage large : c'est la propriété qui compte, plus qu'une valeur
      // particulière. Un arrondi qui « perd » un franc le perd pour quelqu'un.
      for (let subTotal = 1; subTotal <= 20_000; subTotal += 37) {
        for (const percent of [0, 5, 8, 8.5, 10, 12, 12.25, 15, 33.33]) {
          const r = computePayoutBreakdown({
            subTotalXaf: subTotal,
            commissionPercent: percent,
          });
          expect(r.commissionAmount + r.payoutAmount).toBe(r.grossAmount);
          expect(Number.isInteger(r.commissionAmount)).toBe(true);
          expect(Number.isInteger(r.payoutAmount)).toBe(true);
          expect(r.payoutAmount).toBeGreaterThanOrEqual(0);
        }
      }
    });

    it('gère les taux décimaux sans dérive flottante', () => {
      // `1234 * 8.5 / 100` vaut 104.88999999999999 en JavaScript. Le calcul
      // passe par les points de base, donc par des entiers.
      const r = computePayoutBreakdown({
        subTotalXaf: 1234,
        commissionPercent: 8.5,
      });
      expect(r.commissionAmount).toBe(105);
      expect(r.payoutAmount).toBe(1129);
      expect(r.commissionAmount + r.payoutAmount).toBe(1234);
    });

    it('taux à 0 % : le vendeur touche tout', () => {
      const r = computePayoutBreakdown({
        subTotalXaf: 7500,
        commissionPercent: 0,
      });
      expect(r.commissionAmount).toBe(0);
      expect(r.payoutAmount).toBe(7500);
    });

    it('borne les taux aberrants au plafond, et fige le taux RÉELLEMENT appliqué', () => {
      const r = computePayoutBreakdown({
        subTotalXaf: 1000,
        commissionPercent: 300,
      });
      // Le taux retourné est celui qu'on va enregistrer : il doit décrire ce qui
      // a été fait, pas ce qui a été demandé.
      expect(r.commissionPercent).toBe(MAX_COMMISSION_PERCENT);
      expect(r.commissionAmount).toBe(500);
      expect(r.payoutAmount).toBe(500);
    });

    it('arrondit au franc le plus proche, pas vers le bas', () => {
      // 333 × 10 % = 33,3 → 33 ; 335 × 10 % = 33,5 → 34
      expect(
        computePayoutBreakdown({ subTotalXaf: 333, commissionPercent: 10 })
          .commissionAmount,
      ).toBe(33);
      expect(
        computePayoutBreakdown({ subTotalXaf: 335, commissionPercent: 10 })
          .commissionAmount,
      ).toBe(34);
    });
  });

  describe('toXaf', () => {
    it('arrondit les Float hérités de la base', () => {
      expect(toXaf(4999.6)).toBe(5000);
      expect(toXaf(1250.4)).toBe(1250);
    });

    it('refuse ce qui ne peut pas être un montant', () => {
      expect(() => toXaf(NaN)).toThrow();
      expect(() => toXaf(Infinity)).toThrow();
      expect(() => toXaf(-1)).toThrow();
      expect(() => toXaf(999_999_999)).toThrow();
    });
  });

  describe('percentToBasisPoints', () => {
    it('convertit avec deux décimales de précision', () => {
      expect(percentToBasisPoints(10)).toBe(1000);
      expect(percentToBasisPoints(8.5)).toBe(850);
      expect(percentToBasisPoints(12.25)).toBe(1225);
      expect(percentToBasisPoints(0)).toBe(0);
    });

    it('refuse un taux négatif', () => {
      expect(() => percentToBasisPoints(-5)).toThrow();
    });
  });

  describe('applyBasisPoints', () => {
    it('reste exact sur de gros montants', () => {
      expect(applyBasisPoints(100_000_000, 1000)).toBe(10_000_000);
      // Produit intermédiaire = 5×10¹¹, très en deçà de Number.MAX_SAFE_INTEGER.
      expect(applyBasisPoints(100_000_000, 5000)).toBe(50_000_000);
    });
  });
});
