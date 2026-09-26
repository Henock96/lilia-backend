import {
  legacyPolicy,
  planStockUpdate,
  stockColumnsForCreate,
  type CurrentStock,
} from './stock-policy';

/** F3-10 — `stockPolicy` remplace `stockMode` + « null = illimité ». */
describe('stock-policy', () => {
  const now = new Date('2026-09-27T10:00:00Z');

  describe('traduction de l’ancien contrat', () => {
    it.each([
      [undefined, null, 'UNLIMITED'],
      ['DAILY', null, 'UNLIMITED'],
      ['PERMANENT', undefined, 'UNLIMITED'],
      ['DAILY', 20, 'DAILY_QUOTA'],
      [undefined, 20, 'DAILY_QUOTA'],
      ['PERMANENT', 60, 'INVENTORY'],
    ] as const)(
      'stockMode=%s stockQuotidien=%s → %s',
      (mode, units, policy) => {
        expect(legacyPolicy(mode, units)).toBe(policy);
      },
    );
  });

  describe('création', () => {
    it('politique explicite « Stock réel »', () => {
      expect(
        stockColumnsForCreate(
          { stockPolicy: 'INVENTORY', stockQuotidien: 60 },
          now,
        ),
      ).toEqual({
        stockPolicy: 'INVENTORY',
        stockMode: 'PERMANENT',
        stockQuotidien: 60,
        stockRestant: 60,
        stockResetAt: null,
      });
    });

    it('« Quantité du jour » date son premier reset', () => {
      expect(stockColumnsForCreate({ stockQuotidien: 20 }, now)).toMatchObject({
        stockPolicy: 'DAILY_QUOTA',
        stockMode: 'DAILY',
        stockResetAt: now,
      });
    });

    it('sans quantité : toujours disponible', () => {
      expect(stockColumnsForCreate({})).toMatchObject({
        stockPolicy: 'UNLIMITED',
        stockRestant: null,
        stockQuotidien: null,
      });
    });

    it('politique limitée sans quantité : refus nominatif', () => {
      expect(() => stockColumnsForCreate({ stockPolicy: 'INVENTORY' })).toThrow(
        /nombre d’unités/,
      );
    });
  });

  describe('édition (règle S-1 conservée)', () => {
    const inventory: CurrentStock = {
      stockPolicy: 'INVENTORY',
      stockMode: 'PERMANENT',
      stockQuotidien: 60,
      stockRestant: 52,
    };
    const quota: CurrentStock = {
      stockPolicy: 'DAILY_QUOTA',
      stockMode: 'DAILY',
      stockQuotidien: 20,
      stockRestant: 5,
    };

    it('rien dans la requête : rien à écrire', () => {
      expect(planStockUpdate(inventory, {})).toBeNull();
    });

    it('même valeur renvoyée par le formulaire : rien à écrire', () => {
      expect(
        planStockUpdate(inventory, {
          stockMode: 'PERMANENT',
          stockQuotidien: 60,
        }),
      ).toBeNull();
    });

    it('quota du jour modifié : écart appliqué en SQL, pas de réalignement', () => {
      expect(planStockUpdate(quota, { stockQuotidien: 25 })).toEqual({
        data: { stockMode: 'DAILY' },
        quotaChange: 25,
      });
    });

    it('changement de politique : compteurs repartent de la quantité', () => {
      expect(
        planStockUpdate(
          quota,
          { stockPolicy: 'INVENTORY', stockQuotidien: 60 },
          now,
        ),
      ).toEqual({
        data: {
          stockPolicy: 'INVENTORY',
          stockMode: 'PERMANENT',
          stockQuotidien: 60,
          stockRestant: 60,
          stockResetAt: null,
        },
      });
    });

    it('ancienne app qui bascule en PERMANENT garde la quantité déclarée', () => {
      expect(
        planStockUpdate(quota, { stockMode: 'PERMANENT' }, now)?.data,
      ).toMatchObject({
        stockPolicy: 'INVENTORY',
        stockRestant: 20,
      });
    });

    it('null repasse en « Toujours disponible »', () => {
      expect(
        planStockUpdate(inventory, { stockQuotidien: null })?.data,
      ).toEqual({
        stockPolicy: 'UNLIMITED',
        stockMode: 'PERMANENT',
        stockQuotidien: null,
        stockRestant: null,
      });
    });
  });
});
