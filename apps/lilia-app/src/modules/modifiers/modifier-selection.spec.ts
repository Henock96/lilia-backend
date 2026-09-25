import {
  canonicalSignature,
  MODIFIER_LIMITS,
  ModifierSelectionError,
  modifierBlockingReason,
  resolveSelection,
  sameResolution,
  type ModifierCatalogGroup,
  type ModifierCatalogOption,
  type ModifierProductContext,
  type SelectedOptionInput,
} from './modifier-selection';

/**
 * F3-09 — le moteur de sélection, seul juge d'une sélection d'options.
 *
 * Exemple de référence de la fiche :
 *
 *   Poulet braisé — 3 000 FCFA
 *   Accompagnement (obligatoire, 1 choix) : Alloco / Frites / Riz
 *   Sauce (obligatoire, 1 choix)          : Mayonnaise / Piment / Sauce verte
 *   Suppléments (0 à 2)                   : Œuf +300 (×3 max) / Fromage +500
 */
function option(
  id: string,
  extra: Partial<ModifierCatalogOption> = {},
): ModifierCatalogOption {
  return {
    id,
    name: id,
    priceDeltaXaf: 0,
    maxQuantity: 1,
    isAvailable: true,
    deletedAt: null,
    displayOrder: 0,
    ...extra,
  };
}

function group(
  id: string,
  options: ModifierCatalogOption[],
  extra: Partial<ModifierCatalogGroup> = {},
): ModifierCatalogGroup {
  return {
    id,
    restaurantId: 'r1',
    name: id,
    minSelect: 0,
    maxSelect: 1,
    deletedAt: null,
    options,
    ...extra,
  };
}

function poulet(
  overrides: {
    accompagnement?: Partial<ModifierCatalogGroup>;
    alloco?: Partial<ModifierCatalogOption>;
    oeuf?: Partial<ModifierCatalogOption>;
  } = {},
): ModifierProductContext {
  return {
    productName: 'Poulet braisé',
    restaurantId: 'r1',
    groups: [
      group(
        'accompagnement',
        [
          option('alloco', {
            name: 'Alloco',
            displayOrder: 0,
            ...overrides.alloco,
          }),
          option('frites', { name: 'Frites', displayOrder: 1 }),
          option('riz', { name: 'Riz', displayOrder: 2 }),
        ],
        {
          name: 'Accompagnement',
          minSelect: 1,
          maxSelect: 1,
          ...overrides.accompagnement,
        },
      ),
      group(
        'sauce',
        [
          option('mayo', { name: 'Mayonnaise' }),
          option('piment', { name: 'Piment', displayOrder: 1 }),
          option('verte', { name: 'Sauce verte', displayOrder: 2 }),
        ],
        { name: 'Sauce', minSelect: 1, maxSelect: 1 },
      ),
      group(
        'supplements',
        [
          option('oeuf', {
            name: 'Œuf',
            priceDeltaXaf: 300,
            maxQuantity: 3,
            ...overrides.oeuf,
          }),
          option('fromage', {
            name: 'Fromage',
            priceDeltaXaf: 500,
            displayOrder: 1,
          }),
        ],
        { name: 'Suppléments', minSelect: 0, maxSelect: 2 },
      ),
    ],
  };
}

const resolve = (
  selection: SelectedOptionInput[],
  product = poulet(),
  modifiersEnabled = true,
) =>
  resolveSelection({
    basePriceXaf: 3000,
    product,
    selection,
    modifiersEnabled,
  });

function refusal(fn: () => unknown): ModifierSelectionError {
  try {
    fn();
  } catch (err) {
    if (err instanceof ModifierSelectionError) return err;
    throw err;
  }
  throw new Error('aucun refus');
}

const VALID: SelectedOptionInput[] = [
  { optionId: 'alloco', quantity: 1 },
  { optionId: 'piment', quantity: 1 },
];

describe('resolveSelection — prix', () => {
  it('sans supplément : prix de la variante', () => {
    const r = resolve(VALID);
    expect(r.unitPriceXaf).toBe(3000);
    expect(r.optionsTotalXaf).toBe(0);
  });

  it('unitPrice = variante + Σ(delta × quantité)', () => {
    const r = resolve([
      ...VALID,
      { optionId: 'oeuf', quantity: 2 },
      { optionId: 'fromage', quantity: 1 },
    ]);
    expect(r.optionsTotalXaf).toBe(300 * 2 + 500);
    expect(r.unitPriceXaf).toBe(3000 + 1100);
  });

  it('fige nom du groupe, nom de l’option, supplément et quantité, dans l’ordre de la carte', () => {
    const r = resolve([
      { optionId: 'fromage', quantity: 1 },
      { optionId: 'oeuf', quantity: 2 },
      { optionId: 'piment', quantity: 1 },
      { optionId: 'alloco', quantity: 1 },
    ]);
    expect(r.lines).toEqual([
      expect.objectContaining({
        groupName: 'Accompagnement',
        optionName: 'Alloco',
        position: 0,
      }),
      expect.objectContaining({
        groupName: 'Sauce',
        optionName: 'Piment',
        position: 1,
      }),
      expect.objectContaining({
        groupName: 'Suppléments',
        optionName: 'Œuf',
        priceDeltaXaf: 300,
        quantity: 2,
        position: 2,
      }),
      expect.objectContaining({
        groupName: 'Suppléments',
        optionName: 'Fromage',
        priceDeltaXaf: 500,
        quantity: 1,
        position: 3,
      }),
    ]);
  });
});

describe('resolveSelection — cardinalités (options DISTINCTES)', () => {
  it('groupe obligatoire vide → MODIFIER_REQUIRED, jamais de choix automatique', () => {
    const err = refusal(() => resolve([{ optionId: 'piment', quantity: 1 }]));
    expect(err.code).toBe('MODIFIER_REQUIRED');
    expect(err.message).toMatch(/Accompagnement/);
    expect(err.message).toMatch(/mettez à jour l'application/);
  });

  it('application ancienne (aucune option) sur un produit à groupe obligatoire → MODIFIER_REQUIRED', () => {
    expect(refusal(() => resolve([])).code).toBe('MODIFIER_REQUIRED');
  });

  it('deux choix dans un groupe à choix unique → MODIFIER_TOO_MANY', () => {
    const err = refusal(() =>
      resolve([...VALID, { optionId: 'frites', quantity: 1 }]),
    );
    expect(err.code).toBe('MODIFIER_TOO_MANY');
    expect(err.message).toMatch(/un seul choix/);
  });

  it('maxSelect compte les options distinctes, pas les quantités', () => {
    // Œuf ×3 + Fromage ×1 = 2 choix distincts (maxSelect = 2) : accepté.
    expect(() =>
      resolve([
        ...VALID,
        { optionId: 'oeuf', quantity: 3 },
        { optionId: 'fromage', quantity: 1 },
      ]),
    ).not.toThrow();
  });

  it('minSelect compte les options distinctes, pas les quantités', () => {
    const product = poulet({ accompagnement: { minSelect: 2, maxSelect: 3 } });
    product.groups[0].options[0].maxQuantity = 2;
    // Alloco ×2 = UN choix distinct, alors qu'il en faut 2.
    const err = refusal(() =>
      resolve(
        [
          { optionId: 'alloco', quantity: 2 },
          { optionId: 'piment', quantity: 1 },
        ],
        product,
      ),
    );
    expect(err.code).toBe('MODIFIER_REQUIRED');
    expect(err.message).toMatch(/au moins 2 choix/);
  });
});

describe('resolveSelection — quantités et plafonds', () => {
  it('quantité au-delà de maxQuantity → MODIFIER_INVALID_QUANTITY', () => {
    const err = refusal(() =>
      resolve([...VALID, { optionId: 'oeuf', quantity: 4 }]),
    );
    expect(err.code).toBe('MODIFIER_INVALID_QUANTITY');
    expect(err.message).toMatch(/3 au maximum/);
  });

  it('option à prise unique demandée deux fois', () => {
    const err = refusal(() =>
      resolve([
        { optionId: 'alloco', quantity: 2 },
        { optionId: 'piment', quantity: 1 },
      ]),
    );
    expect(err.code).toBe('MODIFIER_INVALID_QUANTITY');
  });

  it.each([0, -1, 1.5, 11])('quantité %p refusée', (quantity) => {
    expect(
      refusal(() => resolve([{ optionId: 'alloco', quantity }])).code,
    ).toBe('MODIFIER_INVALID_QUANTITY');
  });

  it(`plus de ${MODIFIER_LIMITS.MAX_DISTINCT_OPTIONS_PER_LINE} options distinctes → MODIFIER_TOO_MANY`, () => {
    const many = Array.from({ length: 21 }, (_, i) => ({
      optionId: `o${i}`,
      quantity: 1,
    }));
    expect(refusal(() => resolve(many)).code).toBe('MODIFIER_TOO_MANY');
  });

  it(`plus de ${MODIFIER_LIMITS.MAX_TOTAL_OPTION_QUANTITY_PER_LINE} suppléments au total → MODIFIER_TOO_MANY`, () => {
    const many = Array.from({ length: 4 }, (_, i) => ({
      optionId: `o${i}`,
      quantity: 10,
    }));
    const err = refusal(() => resolve(many));
    expect(err.code).toBe('MODIFIER_TOO_MANY');
    expect(err.message).toMatch(/30 suppléments/);
  });
});

describe('resolveSelection — doublons', () => {
  it('A×1 + A×2 n’est PAS A×3 : DUPLICATE_OPTION', () => {
    const err = refusal(() =>
      resolve([
        ...VALID,
        { optionId: 'oeuf', quantity: 1 },
        { optionId: 'oeuf', quantity: 2 },
      ]),
    );
    expect(err.code).toBe('DUPLICATE_OPTION');
  });
});

describe('resolveSelection — appartenance et disponibilité', () => {
  it('option inconnue ou d’un autre produit → MODIFIER_FOREIGN', () => {
    expect(
      refusal(() => resolve([...VALID, { optionId: 'etrangere', quantity: 1 }]))
        .code,
    ).toBe('MODIFIER_FOREIGN');
  });

  it('groupe d’un autre vendeur → ses options sont étrangères', () => {
    const product = poulet();
    product.groups[2] = { ...product.groups[2], restaurantId: 'r2' };
    expect(
      refusal(() =>
        resolve([...VALID, { optionId: 'oeuf', quantity: 1 }], product),
      ).code,
    ).toBe('MODIFIER_FOREIGN');
  });

  it('identifiant mal formé → MODIFIER_FOREIGN', () => {
    expect(
      refusal(() => resolve([{ optionId: 'a:1,b', quantity: 1 }])).code,
    ).toBe('MODIFIER_FOREIGN');
  });

  it('option en rupture → MODIFIER_UNAVAILABLE, nominatif', () => {
    const err = refusal(() =>
      resolve(VALID, poulet({ alloco: { isAvailable: false } })),
    );
    expect(err.code).toBe('MODIFIER_UNAVAILABLE');
    expect(err.message).toMatch(
      /« Alloco » n'est plus disponible pour « Poulet braisé »/,
    );
  });

  it('option supprimée → MODIFIER_UNAVAILABLE', () => {
    const err = refusal(() =>
      resolve(VALID, poulet({ alloco: { deletedAt: new Date() } })),
    );
    expect(err.code).toBe('MODIFIER_UNAVAILABLE');
    expect(err.message).toMatch(/n'est plus proposée/);
  });

  it('groupe supprimé : ses options ne sont plus choisissables, et il n’est plus exigé', () => {
    const product = poulet({ accompagnement: { deletedAt: new Date() } });
    expect(refusal(() => resolve(VALID, product)).code).toBe(
      'MODIFIER_FOREIGN',
    );
    expect(() =>
      resolve([{ optionId: 'piment', quantity: 1 }], product),
    ).not.toThrow();
  });

  it('groupe obligatoire dont toutes les options sont en rupture → produit indisponible (Q5)', () => {
    const product = poulet();
    product.groups[0].options.forEach((o) => (o.isAvailable = false));
    const err = refusal(() =>
      resolve([{ optionId: 'piment', quantity: 1 }], product),
    );
    expect(err.code).toBe('MODIFIER_UNAVAILABLE');
    expect(modifierBlockingReason(product, true)).toMatch(
      /plus aucun choix pour « Accompagnement »/,
    );
    expect(modifierBlockingReason(poulet(), true)).toBeNull();
    // Interrupteur éteint : les groupes n'existent pas pour le client.
    expect(modifierBlockingReason(product, false)).toBeNull();
  });
});

describe('resolveSelection — interrupteur modifiersEnabled', () => {
  it('éteint : les groupes sont ignorés (comportement d’avant F3-09)', () => {
    const r = resolve([], poulet(), false);
    expect(r).toEqual({
      signature: '',
      optionsTotalXaf: 0,
      unitPriceXaf: 3000,
      lines: [],
    });
  });

  it('éteint : une option envoyée est refusée, pas ignorée', () => {
    expect(refusal(() => resolve(VALID, poulet(), false)).code).toBe(
      'MODIFIERS_DISABLED',
    );
  });
});

describe('signature canonique', () => {
  it('ne dépend pas de l’ordre d’entrée', () => {
    expect(
      canonicalSignature([
        { optionId: 'b', quantity: 2 },
        { optionId: 'a', quantity: 1 },
      ]),
    ).toBe('a:1,b:2');
    expect(
      canonicalSignature([
        { optionId: 'a', quantity: 1 },
        { optionId: 'b', quantity: 2 },
      ]),
    ).toBe('a:1,b:2');
  });

  it('vide = ""', () => {
    expect(canonicalSignature([])).toBe('');
  });

  it('la quantité fait partie de l’identité', () => {
    expect(canonicalSignature([{ optionId: 'a', quantity: 1 }])).not.toBe(
      canonicalSignature([{ optionId: 'a', quantity: 2 }]),
    );
  });

  it('tri par points de code, indépendant de la locale', () => {
    expect(
      canonicalSignature([
        { optionId: 'b', quantity: 1 },
        { optionId: 'B', quantity: 1 },
        { optionId: '_', quantity: 1 },
      ]),
    ).toBe('B:1,_:1,b:1');
  });

  it('refuse un doublon plutôt que de produire une signature ambiguë', () => {
    expect(() =>
      canonicalSignature([
        { optionId: 'a', quantity: 1 },
        { optionId: 'a', quantity: 1 },
      ]),
    ).toThrow(ModifierSelectionError);
  });

  it('bornée : 20 identifiants de 40 caractères tiennent sous 1000 (CHECK en base)', () => {
    const max = Array.from({ length: 20 }, (_, i) => ({
      optionId: `${String(i).padStart(2, '0')}${'x'.repeat(38)}`,
      quantity: 1,
    }));
    // quantité 1 × 20 = 20 ≤ 30
    expect(canonicalSignature(max).length).toBeLessThanOrEqual(1000);
  });

  it('la résolution rend la signature canonique', () => {
    expect(
      resolve([
        { optionId: 'piment', quantity: 1 },
        { optionId: 'alloco', quantity: 1 },
      ]).signature,
    ).toBe('alloco:1,piment:1');
  });
});

describe('sameResolution', () => {
  it('détecte un changement de prix d’option', () => {
    const a = resolve([...VALID, { optionId: 'oeuf', quantity: 1 }]);
    const b = resolve(
      [...VALID, { optionId: 'oeuf', quantity: 1 }],
      poulet({ oeuf: { priceDeltaXaf: 400 } }),
    );
    expect(sameResolution(a, a)).toBe(true);
    expect(sameResolution(a, b)).toBe(false);
  });

  it('détecte un renommage (le figé porterait un autre nom)', () => {
    const a = resolve(VALID);
    const b = resolve(VALID, poulet({ alloco: { name: 'Alloco doux' } }));
    expect(sameResolution(a, b)).toBe(false);
  });
});
