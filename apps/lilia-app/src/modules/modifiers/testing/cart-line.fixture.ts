import type { CartLine } from '../cart-line-pricing';
import type { ProductModifierGroupRow } from '../modifier-catalog';

/**
 * Fabrique de `CartLine` complète pour les tests unitaires (hors base).
 *
 * Les tests de caractérisation du checkout décrivaient une ligne de panier par
 * `{ id, quantite }` : tant que le calculateur recevait des `any[]`, rien ne
 * s'en apercevait. Depuis F3-09, une ligne est résolue par le moteur d'options
 * avant tout calcul — elle doit donc ressembler à ce que Prisma charge
 * réellement (`CART_LINE_INCLUDE`).
 */
export function cartLine(
  overrides: Partial<Omit<CartLine, 'product' | 'variant'>> & {
    product?: Partial<CartLine['product']>;
    variant?: Partial<CartLine['variant']>;
    groups?: ProductModifierGroupRow[];
  } = {},
): CartLine {
  const { product, variant, groups, ...line } = overrides;
  const now = new Date('2026-09-26T10:00:00Z');
  return {
    id: 'ci1',
    cartId: 'cart1',
    productId: 'p1',
    menuId: null,
    variantId: 'v1',
    quantite: 1,
    createdAt: now,
    optionsSignature: '',
    options: [],
    menu: null,
    ...line,
    variant: {
      id: 'v1',
      label: 'Standard',
      prix: 10000,
      productId: 'p1',
      stockConsumption: 1,
      createdAt: now,
      updatedAt: now,
      ...variant,
    },
    product: {
      id: 'p1',
      nom: 'Poulet braisé',
      description: null,
      imageUrl: null,
      prixOriginal: 10000,
      stockQuotidien: null,
      stockRestant: null,
      restaurantId: 'resto1',
      categoryId: null,
      productType: 'FOOD',
      stockMode: 'DAILY',
      stockPolicy: 'UNLIMITED',
      stockUnit: 'PIECE',
      stockResetAt: null,
      alcoholContent: null,
      vintage: null,
      origin: null,
      volumeMl: null,
      ingredients: null,
      shelfLifeDays: null,
      madeToOrder: false,
      availableFrom: null,
      availableUntil: null,
      isAvailable: true,
      deletedAt: null,
      displayOrder: 1000,
      createdAt: now,
      updatedAt: now,
      ...product,
      // `groups` l'emporte : c'est l'intention explicite du test.
      modifierGroups: groups ?? product?.modifierGroups ?? [],
    },
  };
}

/** Groupe attaché, au format `PRODUCT_MODIFIER_GROUPS_ARGS`. */
export function attachedGroup(
  group: Partial<ProductModifierGroupRow['group']> & { id: string },
  displayOrder = 0,
): ProductModifierGroupRow {
  return {
    displayOrder,
    group: {
      restaurantId: 'resto1',
      name: group.id,
      minSelect: 0,
      maxSelect: 1,
      deletedAt: null,
      options: [],
      ...group,
    },
  };
}

/** Option de catalogue, au format `MODIFIER_OPTIONS_ARGS`. */
export function catalogOption(
  option: Partial<ProductModifierGroupRow['group']['options'][number]> & {
    id: string;
  },
): ProductModifierGroupRow['group']['options'][number] {
  return {
    name: option.id,
    priceDeltaXaf: 0,
    maxQuantity: 1,
    isAvailable: true,
    deletedAt: null,
    displayOrder: 0,
    ...option,
  };
}
