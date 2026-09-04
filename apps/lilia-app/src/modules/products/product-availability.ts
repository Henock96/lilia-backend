import { Prisma } from '@prisma/client';

/**
 * Disponibilité d'un produit — fixes M1 et M2 (audit du 28/08/2026).
 *
 * **M1** : `availableFrom` / `availableUntil` étaient validés à l'écriture puis
 * **jamais relus** (grep exhaustif) — la fonctionnalité BAKERY de LIL-111 ne
 * fonctionnait tout simplement pas : une viennoiserie « 06:00 → 11:00 » restait
 * commandable à 3 h du matin.
 *
 * **M2** : un produit vendu ne pouvait plus être retiré du catalogue
 * (`OrderItem.productId` en RESTRICT ⇒ 409 dès la première commande). D'où
 * `isAvailable` (indisponible temporairement) et `deletedAt` (retiré, ligne
 * conservée pour l'historique des commandes).
 */

/** Brazzaville = UTC+1 toute l'année (pas d'heure d'été en Afrique centrale). */
const LOCAL_UTC_OFFSET_HOURS = 1;

/** Heure locale au format "HH:mm", comparable lexicographiquement. */
export function localTimeHHmm(now: Date = new Date()): string {
  const local = new Date(now.getTime() + LOCAL_UTC_OFFSET_HOURS * 3600 * 1000);
  const hh = String(local.getUTCHours()).padStart(2, '0');
  const mm = String(local.getUTCMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

/**
 * Le produit est-il dans sa fenêtre de vente ?
 *
 * Une fenêtre dont l'heure de fin précède l'heure de début traverse minuit
 * (« 18:00 → 02:00 ») : la comparaison s'inverse alors.
 */
export function isWithinAvailabilityWindow(
  product: { availableFrom?: string | null; availableUntil?: string | null },
  now: Date = new Date(),
): boolean {
  const from = product.availableFrom;
  const until = product.availableUntil;
  if (!from && !until) return true;

  const current = localTimeHHmm(now);

  if (from && until) {
    return from <= until
      ? current >= from && current <= until
      : current >= from || current <= until; // fenêtre à cheval sur minuit
  }
  if (from) return current >= from;
  return current <= until!;
}

/**
 * Références de colonnes du modèle `Product`, telles que Prisma les expose sur
 * son délégué (`prisma.product.fields`).
 *
 * Elles sont **exigées** — et non optionnelles avec un repli — parce que sans
 * elles la fenêtre horaire ne peut pas être exprimée correctement en SQL (voir
 * plus bas). Un paramètre facultatif aurait laissé chaque appelant retomber en
 * silence sur la version fausse ; le rendre obligatoire fait énumérer les huit
 * sites d'appel par le compilateur.
 */
export type ProductTimeFields = Pick<
  Prisma.ProductFieldRefs,
  'availableFrom' | 'availableUntil'
>;

/**
 * Filtre Prisma du catalogue public : produits ni supprimés ni marqués
 * indisponibles, et dans leur fenêtre horaire.
 *
 * La fenêtre est exprimée en SQL grâce au format "HH:mm" à largeur fixe, qui se
 * compare lexicographiquement comme il se compare chronologiquement.
 *
 * ### Pourquoi une comparaison colonne-à-colonne est nécessaire
 *
 * Une fenêtre est « à cheval sur minuit » quand `availableUntil < availableFrom`
 * (« 18:00 → 02:00 »). Cette condition porte sur **deux colonnes**, pas sur
 * l'heure courante — et la version précédente tentait de s'en passer :
 *
 * ```
 * { availableFrom: { lte: current }, availableUntil: { lt: current } }  // ✗
 * ```
 *
 * Cette branche voulait dire « fenêtre de nuit, on est après l'ouverture » ;
 * elle dit en réalité « la fenêtre est ouverte et déjà terminée », ce qui est
 * vrai de **toute fenêtre normale échue**. Une viennoiserie « 06:00 → 07:00 »
 * restait donc au catalogue tout le reste de la journée. La branche symétrique
 * (`from > current AND until >= current`) rendait de la même façon commandable
 * une fenêtre « 20:00 → 22:00 » à 10 h du matin — c'est-à-dire **avant** son
 * ouverture.
 *
 * Le prédicat en mémoire `isWithinAvailabilityWindow`, lui, était juste : il
 * compare `from` et `until` entre eux. Les deux implémentations d'une même
 * règle divergeaient sur 17 des 49 combinaisons heure × fenêtre, et c'est le
 * SQL — celui qui décide de ce que voit le client — qui avait tort.
 * `product-availability-parity.spec.ts` les compare désormais case par case.
 */
export function availableProductWhere(
  fields: ProductTimeFields,
  now: Date = new Date(),
): Prisma.ProductWhereInput {
  const current = localTimeHHmm(now);

  /** La fenêtre traverse minuit — seule comparaison entre deux colonnes. */
  const crossesMidnight: Prisma.ProductWhereInput = {
    availableUntil: { lt: fields.availableFrom },
  };

  return {
    deletedAt: null,
    isAvailable: true,
    OR: [
      // Aucune fenêtre déclarée → toujours disponible.
      { availableFrom: null, availableUntil: null },
      // Bornes partielles.
      { availableFrom: { lte: current }, availableUntil: null },
      { availableFrom: null, availableUntil: { gte: current } },
      // Fenêtre classique : on est entre les deux bornes. `from <= current` et
      // `current <= until` impliquent `from <= until` — inutile de le vérifier.
      { availableFrom: { lte: current }, availableUntil: { gte: current } },
      // Fenêtre de nuit, première moitié : après l'ouverture, avant minuit.
      { AND: [crossesMidnight, { availableFrom: { lte: current } }] },
      // Fenêtre de nuit, seconde moitié : après minuit, avant la fermeture.
      { AND: [crossesMidnight, { availableUntil: { gte: current } }] },
    ],
  };
}

/**
 * Filtre du **catalogue** : disponibilité, plus exclusion des produits fantômes.
 *
 * Créer un menu `PLAT_SPECIAL` fabrique au passage un `Product` porteur du plat
 * (`MenuCommandService.create`) : c'est lui qui reçoit les lignes de commande,
 * le menu ne pouvant pas en porter directement. Mais ce produit n'est pas un
 * article du catalogue — c'est le corps d'un menu. Sans cette exclusion, le
 * même plat apparaissait **deux fois** au client : une fois comme menu, une
 * fois comme produit sans section rangé dans « Autres ».
 *
 * ⚠️ À ne PAS confondre avec `availableProductWhere`, qui filtre aussi le
 * **contenu** d'un menu (`MenuQueryService`). L'y ajouter viderait les menus
 * `PLAT_SPECIAL` de leur unique composant.
 *
 * Le fantôme est reconnu par sa relation, pas par une colonne : un produit
 * n'est fantôme que parce qu'il compose un plat spécial, et cette vérité vit
 * déjà dans `MenuProduct`. Une colonne `isPhantom` serait une seconde source
 * qui se désynchroniserait.
 */
export function catalogProductWhere(
  fields: ProductTimeFields,
  now: Date = new Date(),
): Prisma.ProductWhereInput {
  return {
    ...availableProductWhere(fields, now),
    menus: { none: { menu: { type: 'PLAT_SPECIAL' } } },
  };
}

/** Raison lisible du refus, ou `null` si le produit est commandable. */
export function unavailabilityReason(
  product: {
    nom?: string | null;
    isAvailable?: boolean;
    deletedAt?: Date | null;
    availableFrom?: string | null;
    availableUntil?: string | null;
  },
  now: Date = new Date(),
): string | null {
  const label = product.nom ? `« ${product.nom} »` : 'Ce produit';

  if (product.deletedAt) return `${label} n'est plus proposé à la vente.`;
  if (product.isAvailable === false)
    return `${label} est actuellement indisponible.`;
  if (!isWithinAvailabilityWindow(product, now)) {
    const window =
      product.availableFrom && product.availableUntil
        ? ` (disponible de ${product.availableFrom} à ${product.availableUntil})`
        : '';
    return `${label} n'est pas disponible à cette heure${window}.`;
  }
  return null;
}
