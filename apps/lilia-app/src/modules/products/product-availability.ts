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
 * Filtre Prisma du catalogue public : produits ni supprimés ni marqués
 * indisponibles, et dans leur fenêtre horaire.
 *
 * La fenêtre est exprimée en SQL grâce au format "HH:mm" à largeur fixe, qui
 * se compare lexicographiquement comme il se compare chronologiquement. Le cas
 * « à cheval sur minuit » est traité par la branche `OR`.
 */
export function availableProductWhere(
  now: Date = new Date(),
): Prisma.ProductWhereInput {
  const current = localTimeHHmm(now);

  return {
    deletedAt: null,
    isAvailable: true,
    OR: [
      // Aucune fenêtre déclarée → toujours disponible.
      { availableFrom: null, availableUntil: null },
      // Fenêtre classique (from <= until) : on est dedans.
      {
        availableFrom: { lte: current },
        availableUntil: { gte: current },
      },
      // Bornes partielles.
      { availableFrom: { lte: current }, availableUntil: null },
      { availableFrom: null, availableUntil: { gte: current } },
      // Fenêtre à cheval sur minuit : from > until, on est après from…
      {
        availableFrom: { lte: current },
        availableUntil: { lt: current },
      },
      // …ou avant until.
      {
        availableFrom: { gt: current },
        availableUntil: { gte: current },
      },
    ],
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
