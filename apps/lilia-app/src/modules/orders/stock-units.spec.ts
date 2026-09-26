import {
  availableForLine,
  requiredStock,
  stockShortage,
  variantStockVerdict,
  withVariantStock,
} from './stock-units';

/**
 * F3-10 — PRICING ≠ INVENTORY. Exemple de référence de la discovery :
 *
 *   Vin Rouge X, 60 bouteilles
 *   Bouteille 13 000 (1) · Carton de 6 70 000 (6) · Carton de 12 135 000 (12)
 *   1 carton de 6 + 2 bouteilles → 8 bouteilles, 96 000 XAF.
 */
const BOUTEILLE = { stockConsumption: 1, label: 'Bouteille', id: 'v-b' };
const CARTON6 = { stockConsumption: 6, label: 'Carton de 6', id: 'v-c6' };
const line = (
  quantite: number,
  variant: { stockConsumption: number } | null,
  extra: Partial<{ productId: string; menuId: string | null }> = {},
) => ({ productId: 'vin', menuId: null, quantite, variant, ...extra });

describe('requiredStock', () => {
  it.each([
    ['1 bouteille', [line(1, BOUTEILLE)], 1],
    ['1 carton de 6', [line(1, CARTON6)], 6],
    ['2 cartons de 6', [line(2, CARTON6)], 12],
    ['3 bouteilles + 1 carton', [line(3, BOUTEILLE), line(1, CARTON6)], 9],
    ['3 bouteilles + 2 cartons', [line(3, BOUTEILLE), line(2, CARTON6)], 15],
    [
      '1 carton de 6 + 2 bouteilles (référence)',
      [line(1, CARTON6), line(2, BOUTEILLE)],
      8,
    ],
  ])('%s', (_label, lines, units) => {
    expect(requiredStock(lines).byProduct.get('vin')).toBe(units);
  });

  it('une ligne sans consommation connue (ancien contrat) pèse sa quantité', () => {
    expect(requiredStock([line(4, null)]).byProduct.get('vin')).toBe(4);
  });

  it('un composant de menu consomme son format × le nombre de menus ; le menu compte q, pas N × q', () => {
    const lines = [
      line(2, CARTON6, { menuId: 'm1' }),
      line(2, BOUTEILLE, { productId: 'jus', menuId: 'm1' }),
    ];
    const { byProduct, byMenu } = requiredStock(lines);
    expect(byProduct.get('vin')).toBe(12);
    expect(byProduct.get('jus')).toBe(2);
    expect(byMenu.get('m1')).toBe(2);
  });
});

describe('variantStockVerdict — statut par format, en ventes possibles', () => {
  it('illimité', () => {
    expect(variantStockVerdict(null, 6)).toEqual({
      availableQuantity: null,
      stockStatus: 'UNLIMITED',
    });
  });

  it('5 bouteilles : la bouteille reste vendable, le carton de 6 est épuisé', () => {
    expect(variantStockVerdict(5, 1)).toEqual({
      availableQuantity: 5,
      stockStatus: 'AVAILABLE',
    });
    expect(variantStockVerdict(5, 6)).toEqual({
      availableQuantity: 0,
      stockStatus: 'OUT_OF_STOCK',
    });
  });

  it('18 bouteilles : « Plus que 3 » cartons, 18 bouteilles disponibles', () => {
    expect(variantStockVerdict(18, 6).stockStatus).toBe('LOW');
    expect(variantStockVerdict(18, 1).stockStatus).toBe('AVAILABLE');
  });

  it('0 = épuisé pour tous les formats', () => {
    expect(variantStockVerdict(0, 1).stockStatus).toBe('OUT_OF_STOCK');
  });
});

describe('availableForLine / stockShortage', () => {
  it('compte les autres lignes du même produit', () => {
    // 60 bouteilles, 50 déjà au panier : il reste 1 carton de 6 possible.
    expect(availableForLine(60, 6, 50)).toBe(1);
    expect(availableForLine(null, 6, 50)).toBeNull();
  });

  it('refus codé, dit dans l’unité du format', () => {
    const error = stockShortage({
      product: { id: 'vin', nom: 'Vin Rouge X', stockRestant: 11 },
      variant: CARTON6,
      quantite: 2,
      otherUnits: 0,
    });
    expect(error?.getResponse()).toMatchObject({
      code: 'OUT_OF_STOCK',
      productId: 'vin',
      variantId: 'v-c6',
      availableQuantity: 1,
      message: "« Vin Rouge X » (Carton de 6) : il n'en reste que 1.",
    });
  });

  it('tient dans le stock : aucun refus', () => {
    expect(
      stockShortage({
        product: { id: 'vin', stockRestant: 12 },
        variant: CARTON6,
        quantite: 2,
        otherUnits: 0,
      }),
    ).toBeNull();
  });
});

describe('withVariantStock — vue publique en liste blanche', () => {
  it('ajoute le verdict et ne publie que les champs déclarés', () => {
    const now = new Date();
    const [view] = withVariantStock([
      {
        stockRestant: 5,
        variants: [
          {
            id: 'v-c6',
            label: 'Carton de 6',
            prix: 70000,
            productId: 'vin',
            createdAt: now,
            updatedAt: now,
            stockConsumption: 6,
            secret: 'ne doit pas sortir',
          } as never,
        ],
      },
    ]);
    expect(view.variants[0]).toEqual({
      id: 'v-c6',
      label: 'Carton de 6',
      prix: 70000,
      productId: 'vin',
      createdAt: now,
      updatedAt: now,
      stockConsumption: 6,
      availableQuantity: 0,
      stockStatus: 'OUT_OF_STOCK',
    });
  });
});
