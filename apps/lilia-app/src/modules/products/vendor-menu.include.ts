import { Prisma } from '@prisma/client';

import { PUBLIC_CATEGORIES_ARGS } from '../categories/category.includes';
import {
  catalogProductWhere,
  isWithinAvailabilityWindow,
  type ProductTimeFields,
} from './product-availability';

/**
 * **La** vue « carte d'un vendeur ». Une seule, partagée.
 *
 * ## Pourquoi ce fichier existe
 *
 * `GET /restaurants/:id` (consommé par le site) et `GET /vendors/:id` (consommé
 * par l'application) répondaient à la même question — « que vend ce
 * commerçant ? » — avec deux `include` Prisma écrits séparément. Ils avaient
 * divergé sur **six points**, mesurés en production le 06/09/2026 :
 *
 * | | `/restaurants/:id` | `/vendors/:id` |
 * |---|---|---|
 * | produits épuisés | inclus | **exclus** |
 * | `take` | 100 | **aucun** |
 * | `orderBy` produits | `createdAt desc` | **aucun** |
 * | menus du jour | absents | inclus |
 * | note moyenne | calculée | **absente** |
 * | `totalProducts` / `hasMoreProducts` | servis | absents |
 *
 * Conséquence concrète : un plat épuisé s'affichait « Rupture » sur le site et
 * **disparaissait** de l'application ; et les 4 vendeurs de production
 * présentaient leurs produits dans un ordre différent selon la plateforme.
 *
 * C'est le même défaut que celui qu'a supprimé `PUBLIC_VENDOR_WHERE` pour la
 * visibilité : **une règle ne se recopie pas, elle s'importe.**
 * `vendor-menu-parity.spec.ts` compare les arguments Prisma réellement
 * construits par les deux services et échoue si l'un s'écarte.
 *
 * ## Les décisions de contrat, et leurs raisons
 *
 * - **Les produits épuisés restent dans la carte.** Un plat qu'on ne peut pas
 *   commander aujourd'hui existe quand même ; le masquer laisse croire au
 *   client qu'il n'est pas au menu, et le fait chercher ailleurs. Les clients
 *   l'affichent grisé avec « Rupture ». Le refus de vente, lui, reste porté par
 *   le serveur (`unavailabilityReason`, panier **et** checkout).
 * - **Les produits hors fenêtre horaire, eux, sortent de la carte**
 *   (`catalogProductWhere`). C'est le comportement en place depuis le fix M1 et
 *   il n'est pas remis en cause ici : « épuisé » est un état du jour qu'on
 *   annonce, « pas encore l'heure » est une absence de l'offre.
 * - **Le tri est explicite de bout en bout.** Sans `orderBy`, PostgreSQL rend
 *   les lignes dans l'ordre de son tas, qui change dès qu'une ligne est mise à
 *   jour. Un ordre non déterministe n'est pas « un autre ordre » : c'est un
 *   ordre qui bouge tout seul entre deux chargements.
 */

/**
 * Nombre de produits embarqués dans la réponse de menu.
 *
 * Ce n'est **pas** un plafond de catalogue : `totalProducts` et
 * `hasMoreProducts` accompagnent la réponse, et les clients complètent en
 * paginant `GET /products?restaurantId=…`, qui applique exactement le même
 * `where` et le même `orderBy` (c'est ce qui rend la page 2 continue de la
 * page 1). Sans cette continuité, paginer ferait réapparaître des produits déjà
 * reçus et en sauter d'autres.
 *
 * 200 plutôt que 100 : la quasi-totalité des vendeurs tient en une réponse, et
 * on n'ouvre un second aller-retour que pour les catalogues qui le justifient.
 */
export const MENU_PRODUCTS_LIMIT = 200;

/**
 * Ordre des produits dans la carte.
 *
 * `displayOrder` porte l'intention du vendeur ; `createdAt desc` départage.
 * Le tri secondaire n'est pas décoratif : tous les produits existants partagent
 * le défaut `1000`, donc **c'est lui qui décide** tant qu'aucun classement n'a
 * été fait — et il reproduit exactement l'ordre que le site affichait déjà.
 * `id` clôt le tri : deux produits créés dans la même milliseconde (import en
 * lot, seed) sauteraient sinon d'un chargement à l'autre.
 */
export const MENU_PRODUCTS_ORDER_BY = [
  { displayOrder: 'asc' },
  { createdAt: 'desc' },
  { id: 'asc' },
] as const satisfies Prisma.ProductOrderByWithRelationInput[];

/**
 * Ordre des variantes : du moins cher au plus cher.
 *
 * Il n'existe pas d'ordre déclaré par le vendeur pour les variantes, et on n'en
 * invente pas ici (cela imposerait une interface de classement que personne n'a
 * demandée). Le besoin réel est ailleurs : les deux catalogues affichaient « le
 * prix de la première variante », or « la première » n'avait aucun sens stable.
 * Trier par prix rend ce choix déterministe **et** juste : la première variante
 * est alors le prix d'appel, celui que les clients annoncent avec « À partir
 * de ».
 */
export const MENU_VARIANTS_ORDER_BY = [
  { prix: 'asc' },
  { id: 'asc' },
] as const satisfies Prisma.ProductVariantOrderByWithRelationInput[];

/** Galerie : couverture d'abord, puis ordre du vendeur, puis départage stable. */
export const MENU_IMAGES_ORDER_BY = [
  { isCover: 'desc' },
  { displayOrder: 'asc' },
  { id: 'asc' },
] as const satisfies Prisma.ProductImageOrderByWithRelationInput[];

/**
 * Arguments de lecture des produits d'une carte — `where`, `include`, `orderBy`.
 *
 * Exporté séparément de `vendorMenuInclude` parce que `GET /products` doit
 * pouvoir appliquer **exactement** les mêmes, sans les catégories ni les menus :
 * c'est la route par laquelle les clients complètent une carte tronquée.
 */
export function menuProductsArgs(fields: ProductTimeFields, now = new Date()) {
  return {
    where: catalogProductWhere(fields, now),
    include: {
      category: true,
      variants: { orderBy: [...MENU_VARIANTS_ORDER_BY] },
      images: { orderBy: [...MENU_IMAGES_ORDER_BY] },
    },
    orderBy: [...MENU_PRODUCTS_ORDER_BY],
  } satisfies Prisma.Restaurant$productsArgs;
}

/**
 * `include` complet de la carte : sections, produits, menus du jour.
 *
 * Construit par appel et non déclaré en constante : le filtre des menus dépend
 * de `now`, et une constante figerait la date au chargement du module.
 *
 * ⚠️ `fields` est un paramètre, jamais `this.prisma.product.fields` : cette
 * fonction vit hors de toute classe. Avoir voulu y lire `this` a déjà mis
 * `GET /vendors/:id` en 500 en production (cf. `CLAUDE.local.md`).
 */
export function vendorMenuInclude(fields: ProductTimeFields, now = new Date()) {
  return {
    // Sections de la carte — actives uniquement, dans l'ordre du vendeur.
    categories: PUBLIC_CATEGORIES_ARGS,
    products: {
      ...menuProductsArgs(fields, now),
      take: MENU_PRODUCTS_LIMIT,
    },
    // Menus du jour actifs. Embarqués ici pour éviter un second appel
    // `GET /menus/active` sur l'écran de détail — et surtout pour que les deux
    // plateformes les reçoivent : le site ne les affichait pas du tout, parce
    // que sa route ne les servait pas.
    menuDuJour: {
      where: { isActive: true, dateDebut: { lte: now }, dateFin: { gte: now } },
      include: {
        products: {
          include: {
            product: {
              include: {
                category: true,
                variants: { orderBy: [...MENU_VARIANTS_ORDER_BY] },
              },
            },
          },
          orderBy: { ordre: 'asc' },
        },
        // Requis par `MenuDuJour.fromJson` côté Flutter (`json['restaurant']`).
        restaurant: { select: { id: true, nom: true, imageUrl: true } },
        images: { orderBy: [{ isCover: 'desc' }, { displayOrder: 'asc' }] },
      },
      orderBy: { dateDebut: 'desc' },
    },
    // Compte **tous** les produits de la carte, pas seulement ceux embarqués :
    // c'est lui qui dit au client s'il doit paginer. Le même `where` que
    // `products`, sinon le total ne compterait pas la même chose que la liste.
    _count: {
      select: { products: { where: catalogProductWhere(fields, now) } },
    },
  } satisfies Prisma.RestaurantInclude;
}

/** Produit tel que le rend `menuProductsArgs` — le minimum dont on a besoin. */
type MenuProductRow = {
  availableFrom?: string | null;
  availableUntil?: string | null;
};

/**
 * Attache le verdict horaire du serveur à chaque produit de la carte.
 *
 * Calculé ici, jamais par le client. La règle — bornes « HH:mm » comparées dans
 * le fuseau de Brazzaville, fenêtres à cheval sur minuit — n'existe qu'à un
 * seul endroit, `isWithinAvailabilityWindow`, celui-là même qu'applique le
 * checkout pour accepter ou refuser une commande.
 *
 * L'application recopiait cette règle en Dart, avec deux erreurs : l'heure de
 * l'appareil au lieu de celle de Brazzaville, et une comparaison qui rendait
 * **toujours faux** une fenêtre « 22:00 → 02:00 ». C'est exactement la
 * divergence que le fix SQL d'août avait corrigée côté serveur, réapparue côté
 * client.
 *
 * ⚠️ Cette valeur est **périssable** : une réponse mise en cache plus de
 * quelques minutes annoncera « disponible » après la fermeture de la fenêtre.
 * C'est la raison d'être du `cacheLife('minutes')` côté web et du TTL côté
 * mobile — et la raison pour laquelle les clients gardent un repli local
 * calculé avec *la même* règle.
 */
export function withAvailableNow<T extends MenuProductRow>(
  products: T[],
  now = new Date(),
): (T & { availableNow: boolean })[] {
  return products.map((product) => ({
    ...product,
    availableNow: isWithinAvailabilityWindow(product, now),
  }));
}
