import { Prisma } from '@prisma/client';

import type {
  ModifierCatalogGroup,
  ModifierProductContext,
} from './modifier-selection';

/**
 * F3-09 — lecture du catalogue d'options pour le moteur de sélection.
 *
 * Une seule forme de lecture (`PRODUCT_MODIFIER_GROUPS_ARGS`), embarquée dans
 * les `include` du panier et du checkout : Prisma la charge par lots (une
 * requête par niveau de relation, pas une par ligne), donc un panier de 10
 * lignes ne coûte pas 10 allers-retours.
 *
 * La sélection est **explicite** : ces objets ne sortent jamais tels quels
 * vers un client — la vue publique est construite par `modifier-views.ts`.
 */

/** Options d'un groupe, toutes (supprimées comprises), dans l'ordre du vendeur. */
export const MODIFIER_OPTIONS_ARGS = {
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
} as const satisfies Prisma.ModifierGroup$optionsArgs;

/** Groupes attachés à un produit, dans l'ordre du produit. */
export const PRODUCT_MODIFIER_GROUPS_ARGS = {
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
        options: MODIFIER_OPTIONS_ARGS,
      },
    },
  },
} as const satisfies Prisma.Product$modifierGroupsArgs;

export type ProductModifierGroupRow = Prisma.ProductModifierGroupGetPayload<
  typeof PRODUCT_MODIFIER_GROUPS_ARGS
>;

/** Ramène les lignes Prisma à la forme qu'attend le moteur. */
export function toModifierContext(product: {
  nom: string;
  restaurantId: string;
  modifierGroups: ProductModifierGroupRow[];
}): ModifierProductContext {
  return {
    productName: product.nom,
    restaurantId: product.restaurantId,
    groups: product.modifierGroups.map(
      (attach): ModifierCatalogGroup => attach.group,
    ),
  };
}

/**
 * Pose des verrous PARTAGÉS sur les attaches, groupes et options des produits
 * donnés, pour la durée de la transaction courante (checkout).
 *
 * ## Pourquoi
 *
 * Le checkout résout les options hors transaction pour calculer les montants,
 * puis les résout **de nouveau sous verrou** avant de figer la commande. Sans
 * ces verrous, une rupture, une suppression, un détachement ou un changement
 * de prix pourrait être validé par un vendeur **entre** la relecture et le
 * `COMMIT` : la commande porterait une option qui n'était déjà plus vendable.
 *
 * `FOR SHARE` fait attendre toute écriture concurrente sur ces lignes jusqu'à
 * la fin du checkout — et fait attendre le checkout jusqu'à la fin d'une
 * écriture déjà engagée, dont il relit ensuite le résultat (READ COMMITTED :
 * chaque instruction voit le dernier état validé).
 *
 * ## Ordre de verrouillage (anti-interblocage)
 *
 * Checkout : `Cart` → attaches → groupes → options → `CartItem` (suppression).
 * Écritures vendeur : option/groupe/attache **d'abord**, `CartItem` ensuite
 * (`ModifiersService`). Aucune écriture vendeur ne verrouille `CartItem` avant
 * une option : les deux ordres ne peuvent pas se croiser.
 *
 * On ne verrouille PAS `Product` : la décrémentation de stock du même checkout
 * le met à jour, et un verrou partagé promu en exclusif par deux checkouts
 * concurrents est l'interblocage d'école.
 *
 * Limite assumée : une attache NOUVELLE (insertion) n'est pas bloquée — un
 * verrou de ligne ne couvre pas une ligne qui n'existe pas encore. Attacher un
 * groupe ne rend invalide aucune option déjà choisie ; au pire la commande
 * passe sans le groupe fraîchement ajouté.
 */
export async function lockModifierRows(
  tx: Prisma.TransactionClient,
  productIds: readonly string[],
): Promise<void> {
  if (productIds.length === 0) return;
  const ids = [...new Set(productIds)].sort();
  await tx.$queryRaw`
    SELECT 1 FROM "ProductModifierGroup"
     WHERE "productId" IN (${Prisma.join(ids)})
     ORDER BY "productId", "groupId"
       FOR SHARE`;
  await tx.$queryRaw`
    SELECT 1 FROM "ModifierGroup" g
     WHERE g.id IN (SELECT "groupId" FROM "ProductModifierGroup"
                     WHERE "productId" IN (${Prisma.join(ids)}))
     ORDER BY g.id
       FOR SHARE`;
  await tx.$queryRaw`
    SELECT 1 FROM "ModifierOption" o
     WHERE o."groupId" IN (SELECT "groupId" FROM "ProductModifierGroup"
                            WHERE "productId" IN (${Prisma.join(ids)}))
     ORDER BY o.id
       FOR SHARE`;
}
