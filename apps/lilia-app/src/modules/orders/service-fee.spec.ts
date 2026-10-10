import { VendorType } from '@prisma/client';

import { toCartView } from '../cart/cart-view';
import { OrderCalculatorService } from './order-calculator.service';
import { serviceFeeBasisPoints, serviceFeePercentOf } from './service-fee';

/**
 * Décision D-4 (10/10/2026) : frais de service propres aux épiceries.
 *
 * Deux garanties :
 *  1. le taux épicerie ne s'applique qu'aux épiceries, et seulement une fois
 *     posé (`NULL` = taux général) ;
 *  2. le passage du calcul en points de base (règle 5) ne change le montant
 *     d'AUCUNE commande actuelle.
 */
describe('Frais de service — taux effectif (D-4)', () => {
  const settings = (groceryServiceFeeBps: number | null) => ({
    serviceFeePercent: 15,
    groceryServiceFeeBps,
  });

  it('épicerie, taux épicerie posé (5 %) : 500 bps', () => {
    expect(serviceFeeBasisPoints(settings(500), VendorType.GROCERY)).toBe(500);
  });

  it('épicerie, taux épicerie NON posé : taux général (aucun changement au déploiement)', () => {
    expect(serviceFeeBasisPoints(settings(null), VendorType.GROCERY)).toBe(
      1500,
    );
  });

  it('épicerie à 0 % : 0 est un taux, pas une absence', () => {
    expect(serviceFeeBasisPoints(settings(0), VendorType.GROCERY)).toBe(0);
  });

  it.each([
    VendorType.RESTAURANT,
    VendorType.HOME_COOK,
    VendorType.BAKERY,
    VendorType.BEVERAGE_SHOP,
  ])(
    '%s : toujours le taux général, même si le taux épicerie est posé',
    (type) => {
      expect(serviceFeeBasisPoints(settings(500), type)).toBe(1500);
    },
  );

  it('taux général décimal (8,5 %) : 850 bps exactement', () => {
    expect(
      serviceFeeBasisPoints(
        { serviceFeePercent: 8.5, groceryServiceFeeBps: null },
        VendorType.RESTAURANT,
      ),
    ).toBe(850);
  });

  it('pourcentage affiché : 500 bps → 5, 1500 → 15', () => {
    expect(serviceFeePercentOf(500)).toBe(5);
    expect(serviceFeePercentOf(1500)).toBe(15);
  });
});

describe('toCartView — porte le taux transmis (D-4)', () => {
  const empty = {
    id: 'c1',
    userId: 'u1',
    createdAt: new Date('2026-10-10'),
    updatedAt: new Date('2026-10-10'),
    items: [],
  };

  it('le taux de la boutique est recopié tel quel', () => {
    expect(toCartView(empty as never, false, 5).serviceFeePercent).toBe(5);
  });

  it('sans taux (appel historique) : null', () => {
    expect(toCartView(empty as never, false).serviceFeePercent).toBeNull();
  });
});

describe('OrderCalculatorService — frais de service en points de base', () => {
  const calculator = new OrderCalculatorService();
  /** Une ligne individuelle (hors menu) au prix unitaire donné. */
  const line = (unitPriceXaf: number) =>
    ({
      line: { quantite: 1, menuId: null, menu: null },
      selection: { unitPriceXaf },
    }) as never;

  it('épicerie à 5 % : 20 000 de sous-total → 1 000 de frais', () => {
    const amounts = calculator.calculate([line(20_000)], 1000, true, 500);
    expect(amounts.serviceFee).toBe(1000);
    expect(amounts.total).toBe(20_000 + 1000 + 1000);
  });

  it('ancien calcul et nouveau donnent le même montant (sous-totaux 0 → 100 000, taux 0 / 8 / 8,5 / 15 %)', () => {
    for (const percent of [0, 8, 8.5, 15]) {
      const bps = Math.round(percent * 100);
      for (let subTotal = 0; subTotal <= 100_000; subTotal += 37) {
        const before = Math.round((subTotal * percent) / 100);
        const after = calculator.calculate(
          [line(subTotal)],
          0,
          false,
          bps,
        ).serviceFee;
        expect(after).toBe(before);
      }
    }
  });
});
