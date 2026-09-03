import { Prisma, VendorType } from '@prisma/client';

import { slugifyCategoryName } from './category-slug';

/**
 * Constantes partagées des sections de menu (catégories).
 *
 * Regroupées ici selon la convention du dépôt (`restaurant.includes.ts`) : une
 * règle de visibilité ou de tri recopiée à la main sur plusieurs requêtes finit
 * par diverger sur l'une d'elles.
 */

/**
 * Catégories telles qu'un CLIENT doit les voir : actives uniquement, dans
 * l'ordre voulu par le vendeur.
 *
 * `displayOrder` puis `nom` : deux catégories créées à la suite partagent
 * l'ordre 0 par défaut, et un tri instable ferait sauter les sections d'un
 * chargement à l'autre.
 */
export const PUBLIC_CATEGORIES_ARGS = {
  where: { isActive: true },
  orderBy: [{ displayOrder: 'asc' }, { nom: 'asc' }],
} as const satisfies Prisma.Restaurant$categoriesArgs;

/** Même tri, mais sans filtre : vue vendeur / administration. */
export const OWNER_CATEGORIES_ORDER_BY = [
  { displayOrder: 'asc' },
  { nom: 'asc' },
] as const satisfies Prisma.CategoryOrderByWithRelationInput[];

/**
 * Sections créées d'office à la naissance d'un vendeur.
 *
 * Elles existent pour supprimer un état, pas pour imposer un vocabulaire : sans
 * elles, un vendeur neuf n'a aucune catégorie, donc le formulaire produit n'en
 * propose aucune, donc aucun produit ne peut en porter — et la liste reste vide
 * pour toujours. Le vendeur les renomme, les réordonne ou les supprime
 * librement.
 *
 * L'ordre du tableau est l'ordre d'affichage initial.
 */
export const DEFAULT_CATEGORIES_BY_VENDOR_TYPE: Record<VendorType, string[]> = {
  RESTAURANT: ['Plats', 'Accompagnements', 'Boissons'],
  HOME_COOK: ['Plats', 'Desserts'],
  BAKERY: ['Pains', 'Viennoiseries', 'Pâtisseries'],
  BEVERAGE_SHOP: ['Sodas', 'Jus', 'Eaux'],
  GROCERY: ['Épicerie', 'Boissons'],
};

/**
 * Sections par défaut sous forme de `create` imbriqué, à poser directement dans
 * le `restaurant.create` de chacun des trois chemins de création.
 *
 * Imbriqué plutôt qu'appelé après coup : la création des sections est alors
 * **dans la transaction du vendeur** par construction. Si le vendeur existe,
 * ses sections existent — il n'y a pas d'état intermédiaire où un commerce
 * naîtrait sans carte parce qu'une seconde écriture a échoué. C'est aussi ce
 * qui évite d'injecter `CategoriesService` dans trois modules et d'y créer des
 * dépendances circulaires.
 */
export function defaultCategoriesCreateInput(
  vendorType: VendorType,
): Prisma.CategoryCreateWithoutRestaurantInput[] {
  return (DEFAULT_CATEGORIES_BY_VENDOR_TYPE[vendorType] ?? []).map(
    (nom, index) => ({
      nom,
      slug: slugifyCategoryName(nom),
      displayOrder: index,
    }),
  );
}
