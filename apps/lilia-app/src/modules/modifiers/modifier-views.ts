import { Prisma } from '@prisma/client';

import { toModifierContext } from './modifier-catalog';
import { modifierBlockingReason } from './modifier-selection';

/**
 * F3-09 — projection PUBLIQUE des options d'un produit.
 *
 * Lue par la carte (`GET /vendors/:id`, `GET /restaurants/:id`), le catalogue
 * paginé (`GET /products`) et la fiche (`GET /products/:id`). Une seule
 * définition, importée par `vendor-menu.include.ts` : la spec de parité tient
 * les deux routes de carte ensemble, options comprises.
 *
 * Sélection **explicite** (règle « projection publique ») : ni `deletedAt`, ni
 * `restaurantId`, ni horodatages ne sortent. Les groupes et options supprimés
 * sont exclus en SQL ; les options en rupture restent, grisées par les clients
 * (`isAvailable: false`) — un accompagnement qu'on n'a plus ce soir existe
 * quand même, le masquer ferait croire qu'il n'a jamais été proposé.
 */
export const PUBLIC_PRODUCT_MODIFIER_GROUPS_ARGS = {
  where: { group: { deletedAt: null } },
  orderBy: [{ displayOrder: 'asc' }, { groupId: 'asc' }],
  select: {
    displayOrder: true,
    group: {
      select: {
        id: true,
        restaurantId: true,
        name: true,
        minSelect: true,
        maxSelect: true,
        deletedAt: true,
        options: {
          where: { deletedAt: null },
          orderBy: [{ displayOrder: 'asc' }, { id: 'asc' }],
          select: {
            id: true,
            name: true,
            priceDeltaXaf: true,
            maxQuantity: true,
            isAvailable: true,
            deletedAt: true,
            displayOrder: true,
          },
        },
      },
    },
  },
} as const satisfies Prisma.Product$modifierGroupsArgs;

type PublicAttachRow = Prisma.ProductModifierGroupGetPayload<
  typeof PUBLIC_PRODUCT_MODIFIER_GROUPS_ARGS
>;

export interface PublicModifierOption {
  id: string;
  name: string;
  priceDeltaXaf: number;
  maxQuantity: number;
  isAvailable: boolean;
}

export interface PublicModifierGroup {
  id: string;
  name: string;
  minSelect: number;
  maxSelect: number;
  /** `minSelect >= 1` — redondant, mais évite à chaque client de le déduire. */
  required: boolean;
  options: PublicModifierOption[];
}

function toPublicGroup(attach: PublicAttachRow): PublicModifierGroup {
  const { group } = attach;
  return {
    id: group.id,
    name: group.name,
    minSelect: group.minSelect,
    maxSelect: group.maxSelect,
    required: group.minSelect >= 1,
    options: group.options.map((option) => ({
      id: option.id,
      name: option.name,
      priceDeltaXaf: option.priceDeltaXaf,
      maxQuantity: option.maxQuantity,
      isAvailable: option.isAvailable,
    })),
  };
}

/**
 * Remplace les lignes Prisma par la vue publique et ajoute le verdict du
 * serveur sur la commandabilité du produit **à cause de ses options**
 * (`modifiersUnavailableReason`, Q5 : groupe obligatoire sans aucune option
 * vendable) — calculé par la même règle que le panier et le checkout.
 *
 * Interrupteur éteint : `modifierGroups: []`, raison `null` — la carte est
 * exactement celle d'avant F3-09.
 */
export function withPublicModifiers<
  T extends {
    nom: string;
    restaurantId: string;
    modifierGroups: PublicAttachRow[];
  },
>(
  products: T[],
  modifiersEnabled: boolean,
): (Omit<T, 'modifierGroups'> & {
  modifierGroups: PublicModifierGroup[];
  modifiersUnavailableReason: string | null;
})[] {
  if (!modifiersEnabled) {
    return products.map((product) => ({
      ...product,
      modifierGroups: [],
      modifiersUnavailableReason: null,
    }));
  }
  return products.map((product) => ({
    ...product,
    modifierGroups: product.modifierGroups.map(toPublicGroup),
    modifiersUnavailableReason: modifierBlockingReason(
      toModifierContext(product),
      true,
    ),
  }));
}
