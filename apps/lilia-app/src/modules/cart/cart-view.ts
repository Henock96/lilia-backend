import { Prisma } from '@prisma/client';

import {
  CART_LINE_INCLUDE,
  isMenuLine,
  lineTotalsXaf,
  quoteCartLine,
  type CartLine,
  type CartLineIssue,
} from '../modifiers/cart-line-pricing';

/**
 * F3-09 — la réponse de `GET /cart` (et de toutes les écritures du panier).
 *
 * ## Le serveur est l'autorité des montants
 *
 * Jusqu'ici la réponse ne portait aucun total : les trois clients recalculaient
 * `variant.prix × quantite`. Avec des options, ce calcul **sous-estime** le
 * panier. Chaque ligne porte donc :
 *
 * - `unitPriceXaf` — variante + options (le prix que le checkout facturera) ;
 * - `optionsTotalXaf` — la part des options dans ce prix ;
 * - `lineTotalXaf` — ce que la ligne pèse dans le sous-total (pour un menu :
 *   la première ligne porte `menu.prix × quantite`, les suivantes 0) ;
 * - `options[]` — nom du groupe, nom de l'option, supplément, quantité ;
 * - `issue` — `null`, ou `{ code, message }` si la ligne n'est plus
 *   commandable telle quelle (le checkout la refusera en 409).
 *
 * et le panier porte `subTotalXaf`. Les champs historiques (`product`,
 * `variant`, `menu`…) sont conservés **à l'identique** : une application
 * installée continue de lire ce qu'elle lisait.
 *
 * ## Projection explicite
 *
 * La lecture charge les groupes d'options de chaque produit (pour chiffrer),
 * mais la réponse ne les renvoie pas : elle est construite champ par champ.
 */
export const CART_VIEW_INCLUDE = {
  items: {
    include: CART_LINE_INCLUDE,
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  },
} as const satisfies Prisma.CartInclude;

type CartWithLines = Prisma.CartGetPayload<{
  include: typeof CART_VIEW_INCLUDE;
}>;

export interface CartLineOptionView {
  optionId: string;
  groupId: string;
  groupName: string;
  name: string;
  priceDeltaXaf: number;
  quantity: number;
}

export interface CartLineView {
  id: string;
  cartId: string;
  productId: string;
  menuId: string | null;
  variantId: string;
  quantite: number;
  createdAt: Date;
  product: {
    nom: string;
    imageUrl: string | null;
    restaurantId: string;
    madeToOrder: boolean;
    stockRestant: number | null;
  };
  variant: { label: string | null; prix: number };
  menu: {
    id: string;
    nom: string;
    prix: number;
    imageUrl: string | null;
  } | null;
  optionsSignature: string;
  options: CartLineOptionView[];
  unitPriceXaf: number;
  optionsTotalXaf: number;
  lineTotalXaf: number;
  issue: CartLineIssue | null;
}

export interface CartView {
  id: string;
  userId: string;
  createdAt: Date;
  updatedAt: Date;
  items: CartLineView[];
  /** Somme des `lineTotalXaf` — options comprises. */
  subTotalXaf: number;
  /** Au moins une ligne ne passera pas le checkout telle quelle. */
  hasIssues: boolean;
}

export function toCartView(
  cart: CartWithLines,
  modifiersEnabled: boolean,
): CartView {
  const quotes = cart.items.map((line) => ({
    line,
    ...quoteCartLine(line, modifiersEnabled),
  }));
  const totals = lineTotalsXaf(quotes);
  const items = quotes.map(({ line, selection, issue }, i) =>
    toLineView(line, selection, issue, totals[i]),
  );
  return {
    id: cart.id,
    userId: cart.userId,
    createdAt: cart.createdAt,
    updatedAt: cart.updatedAt,
    items,
    subTotalXaf: totals.reduce((sum, total) => sum + total, 0),
    hasIssues: items.some((item) => item.issue !== null),
  };
}

function toLineView(
  line: CartLine,
  selection: ReturnType<typeof quoteCartLine>['selection'],
  issue: CartLineIssue | null,
  lineTotalXaf: number,
): CartLineView {
  const menu = isMenuLine(line) ? line.menu! : null;
  return {
    id: line.id,
    cartId: line.cartId,
    productId: line.productId,
    menuId: line.menuId,
    variantId: line.variantId,
    quantite: line.quantite,
    createdAt: line.createdAt,
    product: {
      nom: line.product.nom,
      imageUrl: line.product.imageUrl,
      restaurantId: line.product.restaurantId,
      madeToOrder: line.product.madeToOrder,
      stockRestant: line.product.stockRestant,
    },
    variant: { label: line.variant.label, prix: line.variant.prix },
    menu: menu
      ? {
          id: menu.id,
          nom: menu.nom,
          prix: menu.prix,
          imageUrl: menu.imageUrl,
        }
      : null,
    optionsSignature: line.optionsSignature,
    options: selection.lines.map((option) => ({
      optionId: option.optionId,
      groupId: option.groupId,
      groupName: option.groupName,
      name: option.optionName,
      priceDeltaXaf: option.priceDeltaXaf,
      quantity: option.quantity,
    })),
    // Une ligne de menu n'a pas de prix unitaire à elle : `lineTotalXaf` porte
    // la part du menu. `unitPriceXaf` y vaut le prix du menu, pour l'affichage.
    unitPriceXaf: menu ? menu.prix : selection.unitPriceXaf,
    optionsTotalXaf: menu ? 0 : selection.optionsTotalXaf,
    lineTotalXaf,
    issue,
  };
}
