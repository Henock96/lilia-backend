import { BadRequestException } from '@nestjs/common';
import { OrderStatus } from '@prisma/client';

/**
 * Compteurs par statut d'une liste de commandes.
 * Les sept clés sont toujours présentes : un front ne doit pas avoir à deviner
 * qu'une absence vaut zéro.
 */
export type OrderStatusCounts = Record<OrderStatus, number>;

/** Gabarit à zéro, recopié à chaque appel (jamais muté sur place). */
const ZERO_COUNTS: OrderStatusCounts = Object.fromEntries(
  Object.values(OrderStatus).map((s) => [s, 0]),
) as OrderStatusCounts;

/**
 * Traduit un paramètre de requête en valeur d'enum, ou refuse.
 *
 * Écrit **une seule fois** parce que deux routes servent la même liste de
 * commandes — `/admin/orders` et `/orders/restaurant` — et que deux copies
 * d'une règle divergent. C'est la leçon de `availableProductWhere` et de
 * `PUBLIC_VENDOR_WHERE` : la règle ne se recopie pas, elle s'importe.
 *
 * - chaîne vide ou absente → `undefined`, c'est la vue « tous statuts »
 *   (ce qu'un `<select>` renvoie sur son option neutre) ;
 * - valeur inconnue → **400**. L'ancienne implémentation faisait `status as
 *   any` : la faute de frappe partait jusqu'à Prisma et remontait en 500
 *   opaque, illisible depuis le client.
 */
export function parseOrderStatusFilter(
  status?: string,
): OrderStatus | undefined {
  const normalized = status?.trim();
  if (!normalized) return undefined;

  const valid = Object.values(OrderStatus) as string[];
  if (!valid.includes(normalized)) {
    throw new BadRequestException(
      `Statut de commande invalide : ${normalized}. ` +
        `Valeurs acceptées : ${valid.join(', ')}`,
    );
  }
  return normalized as OrderStatus;
}

/**
 * Replie le résultat d'un `groupBy(['status'])` en compteurs complets.
 *
 * ⚠️ Le `groupBy` qui l'alimente doit porter sur le périmètre **sans** le
 * filtre de statut courant : sinon, sélectionner l'onglet « Prêt » remettrait
 * tous les autres compteurs à zéro, et l'interface annoncerait qu'il n'y a
 * plus rien à préparer au moment précis où on regarde autre chose.
 */
export function toOrderStatusCounts(
  grouped: Array<{ status: OrderStatus; _count: { status: number } }>,
): OrderStatusCounts {
  const counts = { ...ZERO_COUNTS };
  for (const row of grouped) {
    counts[row.status] = row._count.status;
  }
  return counts;
}
