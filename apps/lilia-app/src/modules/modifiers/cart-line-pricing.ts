import { Prisma, type StockUnit } from '@prisma/client';

import {
  PRODUCT_MODIFIER_GROUPS_ARGS,
  toModifierContext,
} from './modifier-catalog';
import {
  emptySelection,
  ModifierSelectionError,
  resolveSelection,
  type ModifierErrorCode,
  type ResolvedOptionLine,
  type ResolvedSelection,
} from './modifier-selection';

/**
 * F3-09 — prix d'un panier, ligne par ligne, et figé d'une commande.
 *
 * Avant F3-09, trois morceaux de code savaient ce que coûte un panier :
 * `OrderCalculatorService` (deux fois : sous-total et figé), et l'aperçu promo
 * (`PromoService.validateCodeForCart`), chacun avec sa boucle
 * `variant.prix × quantite` sur des `any[]`. Ils vivent désormais ici, typés
 * par Prisma : le compilateur signale tout site qui voudrait encore lire
 * `variant.prix` comme prix d'une ligne.
 */

/**
 * Ce que le checkout, l'aperçu promo et le panier lisent d'une ligne.
 *
 * `product` est complet (scalaires) : `unavailabilityReason` et le validateur
 * de précommande en lisent la plupart des champs.
 */
export const CART_LINE_INCLUDE = {
  product: { include: { modifierGroups: PRODUCT_MODIFIER_GROUPS_ARGS } },
  variant: true,
  menu: { select: { id: true, nom: true, prix: true, imageUrl: true } },
  options: {
    select: {
      optionId: true,
      quantity: true,
      // État courant de l'option, pour AFFICHER une ligne devenue invalide
      // (nom, supplément) sans la résoudre. Jamais utilisé pour facturer : le
      // prix facturé est celui que rend le moteur.
      option: {
        select: {
          name: true,
          priceDeltaXaf: true,
          group: { select: { id: true, name: true } },
        },
      },
    },
    orderBy: { optionId: 'asc' },
  },
} as const satisfies Prisma.CartItemInclude;

export type CartLine = Prisma.CartItemGetPayload<{
  include: typeof CART_LINE_INCLUDE;
}>;

/** Une ligne et sa résolution — l'unité de calcul de tout ce fichier. */
export interface PricedCartLine {
  line: CartLine;
  selection: ResolvedSelection;
}

/** Ligne appartenant à un menu (le menu porte son propre prix). */
export function isMenuLine(line: {
  menuId: string | null;
  menu: { prix: number } | null;
}): boolean {
  return Boolean(line.menuId && line.menu);
}

/**
 * Résout les options d'une ligne de panier contre le catalogue **courant**.
 *
 * Lève `ModifierSelectionError` si la ligne n'est plus commandable telle
 * quelle : option en rupture ou supprimée, groupe obligatoire ajouté depuis,
 * interrupteur éteint… ou signature stockée qui ne correspond plus aux options
 * stockées (défense : les deux s'écrivent ensemble, dans une transaction).
 */
export function resolveCartLine(
  line: CartLine,
  modifiersEnabled: boolean,
): ResolvedSelection {
  if (isMenuLine(line)) {
    // R-09.6 : pas d'option sur un produit de menu — la base le garantit
    // (CHECK `CartItem_menu_without_options`) ; on ne l'exige pas non plus.
    if (line.options.length > 0 || line.optionsSignature !== '') {
      throw new ModifierSelectionError(
        'MODIFIER_FOREIGN',
        `Un produit de menu ne prend pas d'option (« ${line.product.nom} »).`,
      );
    }
    return emptySelection(line.variant.prix);
  }
  const selection = resolveSelection({
    basePriceXaf: line.variant.prix,
    product: toModifierContext(line.product),
    selection: line.options,
    modifiersEnabled,
  });
  if (selection.signature !== line.optionsSignature) {
    throw new ModifierSelectionError(
      'MODIFIER_FOREIGN',
      `L'article « ${line.product.nom} » est à reconstituer : retirez-le puis ajoutez-le de nouveau.`,
    );
  }
  return selection;
}

/** Problème d'une ligne, tel que l'annonce `GET /cart`. */
export interface CartLineIssue {
  /** F3-10 — `OUT_OF_STOCK` s'ajoute aux codes du moteur d'options. */
  code: ModifierErrorCode | 'OUT_OF_STOCK';
  message: string;
  /** F3-10 — `OUT_OF_STOCK` : ce qu'il reste de CE format (unités de vente). */
  availableQuantity?: number;
}

/**
 * Chiffrage **d'affichage** d'une ligne : ne lève jamais.
 *
 * Ligne valide : la résolution du moteur, telle que le checkout la facturera.
 * Ligne devenue invalide (option en rupture, groupe obligatoire ajouté…) : le
 * prix courant du catalogue (variante + suppléments actuels) pour que le
 * panier reste lisible, **et** `issue` — que le checkout transformera en 409.
 * Ce repli n'est jamais facturé : `priceCartLines` / le checkout, eux, lèvent.
 */
export function quoteCartLine(
  line: CartLine,
  modifiersEnabled: boolean,
): { selection: ResolvedSelection; issue: CartLineIssue | null } {
  try {
    return { selection: resolveCartLine(line, modifiersEnabled), issue: null };
  } catch (err) {
    if (!(err instanceof ModifierSelectionError)) throw err;
    const lines: ResolvedOptionLine[] = line.options.map(
      (choice, position) => ({
        optionId: choice.optionId,
        groupId: choice.option.group.id,
        groupName: choice.option.group.name,
        optionName: choice.option.name,
        priceDeltaXaf: choice.option.priceDeltaXaf,
        quantity: choice.quantity,
        position,
      }),
    );
    const optionsTotalXaf = lines.reduce(
      (sum, option) => sum + option.priceDeltaXaf * option.quantity,
      0,
    );
    return {
      selection: {
        signature: line.optionsSignature,
        optionsTotalXaf,
        unitPriceXaf: line.variant.prix + optionsTotalXaf,
        lines,
      },
      issue: { code: err.code, message: err.message },
    };
  }
}

/** Résout toutes les lignes ; au premier refus, l'erreur remonte. */
export function priceCartLines(
  lines: readonly CartLine[],
  modifiersEnabled: boolean,
): PricedCartLine[] {
  return lines.map((line) => ({
    line,
    selection: resolveCartLine(line, modifiersEnabled),
  }));
}

/**
 * Montant d'une ligne dans le sous-total.
 *
 * - ligne individuelle : prix unitaire (variante + options) × quantité ;
 * - menu : la **première** ligne du groupe porte `menu.prix × quantite`, les
 *   suivantes 0 — la règle que figent les commandes depuis toujours
 *   (`menu-quantities.ts`).
 */
export function lineTotalsXaf(priced: readonly PricedCartLine[]): number[] {
  const seenMenus = new Set<string>();
  return priced.map(({ line, selection }) => {
    if (isMenuLine(line)) {
      if (seenMenus.has(line.menuId!)) return 0;
      seenMenus.add(line.menuId!);
      return line.menu!.prix * line.quantite;
    }
    return selection.unitPriceXaf * line.quantite;
  });
}

/** Sous-total du panier : **la** somme, options comprises. */
export function cartSubtotalXaf(priced: readonly PricedCartLine[]): number {
  return lineTotalsXaf(priced).reduce((sum, total) => sum + total, 0);
}

export interface OrderItemSnapshot {
  productId: string;
  menuId?: string;
  quantite: number;
  /** Prix unitaire complet (variante + options) — décision Q1. */
  prix: number;
  variant: string; // label snapshot
  variantId: string; // ID pour traçabilité
  /** Égal à `prix` : le prix au moment de la commande, options comprises. */
  snapshotPrice: number;
  /** Part des options dans `prix` (ventilation, jamais à rajouter). */
  optionsTotalXaf: number;
  options: ResolvedOptionLine[];
  /** F3-10 — consommation du format au checkout (immuable, donc sûre à lire ici). */
  stockUnitsPerItem: number;
  /** F3-10 — unité de stock du produit, figée pour l'historique. */
  stockUnit: StockUnit;
}

/**
 * Figé des lignes de commande — immuable pour l'historique.
 *
 * Menus : la première ligne du groupe porte le prix du menu, les suivantes 0
 * (logique métier préservée). Lignes individuelles : `prix = snapshotPrice =
 * unitPriceXaf`, et les options sont recopiées (nom du groupe, nom de
 * l'option, supplément, quantité).
 */
export function orderItemSnapshots(
  priced: readonly PricedCartLine[],
): OrderItemSnapshot[] {
  const individual: OrderItemSnapshot[] = [];
  const menuGroups = new Map<string, PricedCartLine[]>();
  for (const entry of priced) {
    const { line, selection } = entry;
    if (isMenuLine(line)) {
      const group = menuGroups.get(line.menuId!) ?? [];
      group.push(entry);
      menuGroups.set(line.menuId!, group);
      continue;
    }
    individual.push({
      productId: line.productId,
      quantite: line.quantite,
      prix: selection.unitPriceXaf,
      variant: line.variant.label ?? 'Standard',
      variantId: line.variantId,
      snapshotPrice: selection.unitPriceXaf,
      optionsTotalXaf: selection.optionsTotalXaf,
      options: selection.lines,
      stockUnitsPerItem: line.variant.stockConsumption,
      stockUnit: line.product.stockUnit,
    });
  }

  const menus: OrderItemSnapshot[] = [];
  for (const [menuId, group] of menuGroups) {
    const menuPrix = group[0].line.menu!.prix;
    group.forEach(({ line }, idx) => {
      menus.push({
        productId: line.productId,
        menuId,
        quantite: line.quantite,
        prix: idx === 0 ? menuPrix : 0,
        variant: line.variant.label ?? 'Standard',
        variantId: line.variantId,
        snapshotPrice: idx === 0 ? menuPrix : 0,
        optionsTotalXaf: 0,
        options: [],
        stockUnitsPerItem: line.variant.stockConsumption,
        stockUnit: line.product.stockUnit,
      });
    });
  }
  return [...individual, ...menus];
}
