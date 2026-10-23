import type { Prisma } from '@prisma/client';

/**
 * Ce que le tableau de bord appelle « revenus » — **source unique**.
 *
 * Décision D-5 (23/10/2026) : une commande compte dans les revenus quand elle
 * est **payée et livrée**, et elle y compte **à la date de sa livraison**.
 *
 * Avant, les quatre calculs (`overview`, `orders.totals`, `revenue-chart`,
 * classement des vendeurs) sommaient `Order.total` pour `status ≠ ANNULER`,
 * datés par `createdAt` : des commandes jamais payées (`EN_ATTENTE`, fermées
 * au bout de 45 min) et des échecs de livraison y entraient. Le « revenu du
 * jour » était un volume commandé.
 *
 * Ce périmètre ne se recopie pas, il s'importe :
 * `dashboard-revenue-scope.spec.ts` exige que toute requête qui somme
 * `Order.total` dans le tableau de bord le porte.
 *
 * `paidAt` en plus de `LIVRER` : une commande livrée l'a toujours été après
 * paiement sur le parcours nominal, mais le chiffre d'affaires ne doit pas
 * dépendre de cette hypothèse.
 */
export const REVENUE_ORDER_WHERE = {
  status: 'LIVRER',
  paidAt: { not: null },
} satisfies Prisma.OrderWhereInput;

/** Périmètre des revenus, livrés depuis [since] (tout l'historique si absent). */
export function revenueWhere(since?: Date | null): Prisma.OrderWhereInput {
  return {
    ...REVENUE_ORDER_WHERE,
    ...(since ? { deliveredAt: { gte: since } } : {}),
  };
}
