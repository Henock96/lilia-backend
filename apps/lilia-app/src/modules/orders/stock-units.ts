import { BadRequestException } from '@nestjs/common';

import { LOW_STOCK_THRESHOLD } from '../products/stock-status';
import { countMenus } from './menu-quantities';

/**
 * F3-10 — combien d'unités de stock une liste de lignes consomme.
 *
 * ## PRICING ≠ INVENTORY
 *
 * Une ligne a une quantité **commerciale** (`quantite` : 2 cartons) et un prix
 * (`variant.prix`, options comprises). Son poids en stock est une autre
 * dimension : `quantite × stockConsumption` (2 cartons de 6 = 12 bouteilles).
 * Aucune ne se déduit de l'autre — jamais `prix / prix de la bouteille`.
 *
 * Les options F3-09 n'entrent **pas** dans le calcul : une « caisse premium »
 * ne consomme pas de bouteille.
 *
 * ## Une seule fonction
 *
 * Panier, validateur, réservation, reorder la partagent. Avant F3-10, trois
 * agrégations recopiées comptaient `Σ quantite` chacune de leur côté ; le jour
 * où l'une d'elles aurait oublié la consommation, le panier aurait accepté ce
 * que le checkout refuse.
 */

/** Ce que le calcul lit d'une ligne (panier ou commande). */
export interface StockLine {
  productId: string;
  menuId?: string | null;
  quantite: number;
  /** Consommation de la variante ; absente = 1 (ancien contrat). */
  variant?: { stockConsumption?: number | null } | null;
}

export function stockConsumptionOf(line: StockLine): number {
  return line.variant?.stockConsumption ?? 1;
}

export function lineStockUnits(line: StockLine): number {
  return line.quantite * stockConsumptionOf(line);
}

export interface RequiredStock {
  /** Unités de stock par produit (lignes simples ET composants de menu). */
  byProduct: Map<string, number>;
  /** Nombre de menus par menu (un menu = q, pas N × q — fix F-01). */
  byMenu: Map<string, number>;
}

export function requiredStock(lines: readonly StockLine[]): RequiredStock {
  const byProduct = new Map<string, number>();
  for (const line of lines) {
    byProduct.set(
      line.productId,
      (byProduct.get(line.productId) ?? 0) + lineStockUnits(line),
    );
  }
  return { byProduct, byMenu: countMenus(lines) };
}

export type VariantStockStatus =
  | 'UNLIMITED'
  | 'AVAILABLE'
  | 'LOW'
  | 'OUT_OF_STOCK';

export interface VariantStockVerdict {
  /** Unités de VENTE de ce format encore achetables ; `null` = illimité. */
  availableQuantity: number | null;
  stockStatus: VariantStockStatus;
}

/**
 * Verdict d'un format, calculé par le serveur et **publié** : les clients ne
 * le recalculent pas (la règle était recopiée trois fois avant F3-10).
 *
 * `LOW` est compté en ventes possibles **de ce format** : 18 bouteilles,
 * c'est « Plus que 3 » cartons de 6, mais 18 bouteilles à l'unité.
 */
export function variantStockVerdict(
  stockRestant: number | null | undefined,
  stockConsumption = 1,
): VariantStockVerdict {
  if (stockRestant === null || stockRestant === undefined) {
    return { availableQuantity: null, stockStatus: 'UNLIMITED' };
  }
  const availableQuantity = Math.max(
    0,
    Math.floor(stockRestant / Math.max(1, stockConsumption)),
  );
  if (availableQuantity === 0) {
    return { availableQuantity, stockStatus: 'OUT_OF_STOCK' };
  }
  return {
    availableQuantity,
    stockStatus: availableQuantity <= LOW_STOCK_THRESHOLD ? 'LOW' : 'AVAILABLE',
  };
}

/**
 * Combien de ce format le client peut-il encore ajouter, compte tenu des
 * autres lignes du même produit déjà au panier ?
 */
export function availableForLine(
  stockRestant: number | null | undefined,
  stockConsumption: number,
  otherUnitsInCart: number,
): number | null {
  if (stockRestant === null || stockRestant === undefined) return null;
  return Math.max(
    0,
    Math.floor(
      (stockRestant - otherUnitsInCart) / Math.max(1, stockConsumption),
    ),
  );
}

/** Unités de stock, lisibles : « 6 bouteilles », « 1 portion ». */
const UNIT_LABELS: Record<string, [string, string]> = {
  PIECE: ['unité', 'unités'],
  PORTION: ['portion', 'portions'],
  BOTTLE: ['bouteille', 'bouteilles'],
  CAN: ['canette', 'canettes'],
  CUP: ['gobelet', 'gobelets'],
  BAG: ['sachet', 'sachets'],
};

export function formatStockUnits(
  units: number,
  stockUnit?: string | null,
): string {
  const [one, many] = UNIT_LABELS[stockUnit ?? 'PIECE'] ?? UNIT_LABELS.PIECE;
  return `${units} ${units > 1 ? many : one}`;
}

/**
 * Refus de stock, avec un `code` stable (contrat client) et la quantité encore
 * achetable **en unités de vente du format demandé** — `0` = rupture.
 * HTTP 400 conservé : les applications installées lisent `message`.
 */
export function outOfStockError(args: {
  message: string;
  productId: string;
  variantId?: string | null;
  availableQuantity: number;
  cartItemId?: string;
}): BadRequestException {
  return new BadRequestException({
    message: args.message,
    code: 'OUT_OF_STOCK',
    productId: args.productId,
    variantId: args.variantId ?? null,
    availableQuantity: args.availableQuantity,
    ...(args.cartItemId ? { cartItemId: args.cartItemId } : {}),
  });
}

/**
 * Message d'un stock insuffisant, dit dans l'unité du format demandé :
 * « Carton de 6 » : il reste de quoi en servir 1 — plutôt que « 7 unités »,
 * que le client ne peut pas relier à ce qu'il achète.
 */
export function insufficientStockMessage(args: {
  productName: string;
  variantLabel?: string | null;
  stockConsumption: number;
  available: number;
}): string {
  const name =
    args.variantLabel && args.stockConsumption > 1
      ? `« ${args.productName} » (${args.variantLabel})`
      : `« ${args.productName} »`;
  if (args.available <= 0) return `${name} est épuisé.`;
  return args.stockConsumption > 1
    ? `${name} : il n'en reste que ${args.available}.`
    : `${name} : il ne reste que ${args.available} unité${args.available > 1 ? 's' : ''}.`;
}

/**
 * Le format demandé tient-il dans le stock du produit ? `null` si oui, sinon
 * le refus codé `OUT_OF_STOCK` (quantité encore achetable de CE format).
 *
 * @param otherUnits unités de stock déjà prises par les AUTRES lignes du même
 *   produit (autres formats, composants de menu).
 */
export function stockShortage(args: {
  product: { id: string; nom?: string | null; stockRestant?: number | null };
  variant?: {
    id?: string | null;
    label?: string | null;
    stockConsumption?: number | null;
  } | null;
  quantite: number;
  otherUnits: number;
  cartItemId?: string;
}): BadRequestException | null {
  const stock = args.product.stockRestant;
  if (stock === null || stock === undefined) return null;
  const consumption = args.variant?.stockConsumption ?? 1;
  if (args.otherUnits + args.quantite * consumption <= stock) return null;
  const available = availableForLine(stock, consumption, args.otherUnits) ?? 0;
  return outOfStockError({
    message: insufficientStockMessage({
      productName: args.product.nom ?? 'Ce produit',
      variantLabel: args.variant?.label,
      stockConsumption: consumption,
      available,
    }),
    productId: args.product.id,
    variantId: args.variant?.id,
    availableQuantity: available,
    cartItemId: args.cartItemId,
  });
}

/** Ce que la vue publique d'un format expose — liste blanche. */
export interface PublicVariantView extends VariantStockVerdict {
  id: string;
  label: string | null;
  prix: number;
  productId: string;
  createdAt: Date;
  updatedAt: Date;
  stockConsumption: number;
}

/**
 * F3-10 — vue publique des formats d'un produit, **construite champ par
 * champ** (avant : `variants: { orderBy }` publiait toutes les colonnes, et
 * toute colonne ajoutée l'était sans décision), plus le verdict de stock de
 * chaque format. Les champs historiques restent à l'identique : une
 * application installée continue de lire `id`, `label`, `prix`.
 */
export function withVariantStock<
  T extends {
    stockRestant: number | null;
    variants: {
      id: string;
      label: string | null;
      prix: number;
      productId: string;
      createdAt: Date;
      updatedAt: Date;
      stockConsumption: number;
    }[];
  },
>(products: T[]): (Omit<T, 'variants'> & { variants: PublicVariantView[] })[] {
  return products.map((product) => ({
    ...product,
    variants: (product.variants ?? []).map((v) => ({
      id: v.id,
      label: v.label,
      prix: v.prix,
      productId: v.productId,
      createdAt: v.createdAt,
      updatedAt: v.updatedAt,
      stockConsumption: v.stockConsumption,
      ...variantStockVerdict(product.stockRestant, v.stockConsumption),
    })),
  }));
}
