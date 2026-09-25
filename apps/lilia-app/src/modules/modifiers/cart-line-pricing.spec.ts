import {
  cartSubtotalXaf,
  orderItemSnapshots,
  priceCartLines,
  quoteCartLine,
  resolveCartLine,
} from './cart-line-pricing';
import { OrderCalculatorService } from '../orders/order-calculator.service';
import {
  attachedGroup,
  cartLine,
  catalogOption,
} from './testing/cart-line.fixture';

/**
 * F3-09 — chaîne de l'argent, de la ligne de panier au figé de commande.
 *
 * Exemple de la fiche : Poulet 3 000 + Alloco (+500) + Œuf (+300), quantité 2
 *   → prix unitaire 3 800, ligne 7 600.
 */
const GROUPS = [
  attachedGroup({
    id: 'g-acc',
    name: 'Accompagnement',
    minSelect: 1,
    maxSelect: 1,
    options: [
      catalogOption({ id: 'alloco', name: 'Alloco', priceDeltaXaf: 500 }),
      catalogOption({ id: 'riz', name: 'Riz', displayOrder: 1 }),
    ],
  }),
  attachedGroup(
    {
      id: 'g-sup',
      name: 'Suppléments',
      maxSelect: 2,
      options: [
        catalogOption({
          id: 'oeuf',
          name: 'Œuf',
          priceDeltaXaf: 300,
          maxQuantity: 3,
        }),
      ],
    },
    1,
  ),
];

function optionRow(
  optionId: string,
  quantity: number,
  name: string,
  priceDeltaXaf: number,
  group: string,
) {
  return {
    optionId,
    quantity,
    option: { name, priceDeltaXaf, group: { id: group, name: group } },
  };
}

const POULET = cartLine({
  id: 'l1',
  quantite: 2,
  variant: { prix: 3000 },
  groups: GROUPS,
  optionsSignature: 'alloco:1,oeuf:1',
  options: [
    optionRow('alloco', 1, 'Alloco', 500, 'g-acc'),
    optionRow('oeuf', 1, 'Œuf', 300, 'g-sup'),
  ],
});

describe('Prix d’une ligne à options', () => {
  it('unitPrice 3 800, ligne 7 600, options 800', () => {
    const s = resolveCartLine(POULET, true);
    expect(s.unitPriceXaf).toBe(3800);
    expect(s.optionsTotalXaf).toBe(800);
    expect(cartSubtotalXaf([{ line: POULET, selection: s }])).toBe(7600);
  });

  it('le figé porte le prix COMPLET dans prix ET snapshotPrice (Q1)', () => {
    const [snap] = orderItemSnapshots(priceCartLines([POULET], true));
    expect(snap).toMatchObject({
      prix: 3800,
      snapshotPrice: 3800,
      optionsTotalXaf: 800,
      quantite: 2,
    });
    expect(
      snap.options.map((o) => [
        o.groupName,
        o.optionName,
        o.priceDeltaXaf,
        o.quantity,
      ]),
    ).toEqual([
      ['Accompagnement', 'Alloco', 500, 1],
      ['Suppléments', 'Œuf', 300, 1],
    ]);
    // Invariant : Σ(prix × quantite) des figés = sous-total.
    expect(snap.prix * snap.quantite).toBe(7600);
  });

  it('signature stockée qui ne correspond plus aux options → refusée', () => {
    const tampered = { ...POULET, optionsSignature: 'alloco:1' };
    expect(() => resolveCartLine(tampered, true)).toThrow(/reconstituer/);
  });

  it('ancienne ligne sans option, groupe obligatoire ajouté depuis → MODIFIER_REQUIRED', () => {
    const legacy = cartLine({ groups: GROUPS });
    expect(() => resolveCartLine(legacy, true)).toThrow(
      /Choisissez « Accompagnement »/,
    );
    // … et l'affichage reste lisible, avec le problème annoncé.
    const q = quoteCartLine(legacy, true);
    expect(q.issue?.code).toBe('MODIFIER_REQUIRED');
    expect(q.selection.unitPriceXaf).toBe(10000);
  });

  it('option en rupture : GET /cart affiche le prix courant et annonce le problème', () => {
    const line = cartLine({
      ...POULET,
      variant: { prix: 3000 },
      groups: [
        attachedGroup({
          ...GROUPS[0].group,
          options: [
            catalogOption({
              id: 'alloco',
              name: 'Alloco',
              priceDeltaXaf: 500,
              isAvailable: false,
            }),
          ],
        }),
        GROUPS[1],
      ],
    });
    const q = quoteCartLine(line, true);
    expect(q.issue).toEqual({
      code: 'MODIFIER_UNAVAILABLE',
      message: expect.stringMatching(/Alloco/),
    });
    expect(q.selection.unitPriceXaf).toBe(3800);
    expect(() => priceCartLines([line], true)).toThrow();
  });
});

describe('Calculateur de commande — sous-total, frais, commission', () => {
  const calc = new OrderCalculatorService();

  it('options → subTotal → frais de service → commission, sur la même base', () => {
    const amounts = calc.calculate(
      priceCartLines([POULET], true),
      1000,
      true,
      15,
      10,
    );
    expect(amounts.subTotal).toBe(7600);
    expect(amounts.serviceFee).toBe(Math.round(7600 * 0.15));
    expect(amounts.commissionAmount).toBe(760);
    expect(amounts.total).toBe(7600 + 1000 + 1140);
  });

  it('menu : le prix du menu, porté une fois, jamais de supplément', () => {
    const menu = { id: 'm1', nom: 'Menu midi', prix: 5000, imageUrl: null };
    const lines = [
      cartLine({ id: 'm-a', productId: 'a', menuId: 'm1', menu, quantite: 2 }),
      cartLine({ id: 'm-b', productId: 'b', menuId: 'm1', menu, quantite: 2 }),
    ];
    const priced = priceCartLines(lines, true);
    expect(cartSubtotalXaf(priced)).toBe(10000);
    const snaps = orderItemSnapshots(priced);
    expect(snaps.map((s) => s.prix)).toEqual([5000, 0]);
    expect(
      snaps.every((s) => s.optionsTotalXaf === 0 && s.options.length === 0),
    ).toBe(true);
  });

  it('ligne de menu portant une option (impossible en base) → refusée', () => {
    const menu = { id: 'm1', nom: 'Menu', prix: 5000, imageUrl: null };
    const line = cartLine({
      menuId: 'm1',
      menu,
      optionsSignature: 'oeuf:1',
      options: [optionRow('oeuf', 1, 'Œuf', 300, 'g-sup')],
    });
    expect(() => resolveCartLine(line, true)).toThrow(
      /menu ne prend pas d'option/,
    );
  });
});
