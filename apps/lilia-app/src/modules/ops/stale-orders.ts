import { OrderStatus, Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import {
  ORDER_STALE_RULES,
  StaleContext,
  SUPERVISED_ORDER_STATUSES,
  staleThresholdMinutes,
} from './order-stale-rules';

/** Ligne brute : une commande non terminale et son entrée dans l'état. */
export interface StaleCandidate {
  id: string;
  status: OrderStatus;
  isDelivery: boolean;
  scheduledFor: Date | null;
  paidAt: Date | null;
  updatedAt: Date;
  shopName: string;
  delivererId: string | null;
  pickedUpAt: Date | null;
  /** Dernière entrée dans l'état courant (OrderHistory), `null` si absente. */
  enteredAt: Date | null;
}

export interface StaleOrder {
  orderId: string;
  status: OrderStatus;
  context: StaleContext;
  shopName: string;
  /** Depuis quand la commande est dans cet état. */
  since: Date;
  /** `HISTORY` : mesuré sur OrderHistory ; `UPDATED_AT` : repli. */
  sinceSource: 'HISTORY' | 'UPDATED_AT';
  thresholdMinutes: number;
  label: string;
  action: string;
}

export function staleContextOf(c: StaleCandidate): StaleContext {
  if (!c.isDelivery) return 'pickup';
  return c.delivererId && !c.pickedUpAt ? 'assigned' : 'delivery';
}

/**
 * Cas déjà portés par les files historiques du cockpit — pour ne pas montrer
 * deux fois la même commande. Miroir des `where` d'`OpsQueueService` :
 *  - `acceptance_late` : `PAYER` payée depuis ≥ 4 min ;
 *  - `no_driver` : `ACCEPTEE`/`PRET` en livraison sans livreur depuis ≥ 10 min
 *    (mesuré sur `updatedAt`) ;
 *  - `en_route_long` : `EN_ROUTE` récupérée depuis ≥ 60 min.
 */
export function coveredByLegacyBucket(
  c: StaleCandidate,
  now: Date,
  t: {
    acceptanceLateMinutes: number;
    noDriverMinutes: number;
    enRouteMinutes: number;
  },
): boolean {
  const ago = (m: number) => now.getTime() - m * 60_000;
  switch (c.status) {
    case 'PAYER':
      return !!c.paidAt && c.paidAt.getTime() <= ago(t.acceptanceLateMinutes);
    case 'ACCEPTEE':
    case 'PRET':
      return (
        c.isDelivery &&
        !c.delivererId &&
        c.updatedAt.getTime() <= ago(t.noDriverMinutes)
      );
    case 'EN_ROUTE':
      return !!c.pickedUpAt && c.pickedUpAt.getTime() <= ago(t.enRouteMinutes);
    default:
      return false;
  }
}

/**
 * Décide, pour une commande, si elle est immobile au-delà de son seuil.
 * Fonction pure : testée état par état, sans base.
 */
export function evaluateStale(c: StaleCandidate, now: Date): StaleOrder | null {
  const rule = ORDER_STALE_RULES[c.status];
  if (rule === 'TERMINAL') return null;
  // Une précommande n'est pas en retard avant son heure.
  if (c.scheduledFor && c.scheduledFor.getTime() > now.getTime()) return null;

  const context = staleContextOf(c);
  const threshold = staleThresholdMinutes(c.status, context);
  if (threshold === null) return null;

  const since = c.enteredAt ?? c.updatedAt;
  // Pour une précommande, l'attente ne compte qu'à partir de son heure.
  const effectiveSince =
    c.scheduledFor && c.scheduledFor.getTime() > since.getTime()
      ? c.scheduledFor
      : since;
  if (now.getTime() - effectiveSince.getTime() < threshold * 60_000) {
    return null;
  }
  return {
    orderId: c.id,
    status: c.status,
    context,
    shopName: c.shopName,
    since: effectiveSince,
    sinceSource: c.enteredAt ? 'HISTORY' : 'UPDATED_AT',
    thresholdMinutes: threshold,
    label: rule.label,
    action: rule.action,
  };
}

/** Plus petit seuil : borne basse de la requête. */
const MIN_THRESHOLD_MINUTES = Math.min(
  ...SUPERVISED_ORDER_STATUSES.flatMap((s) => {
    const r = ORDER_STALE_RULES[s];
    return r === 'TERMINAL'
      ? []
      : [r.delivery, r.pickup, r.assigned].filter(
          (v): v is number => typeof v === 'number',
        );
  }),
);

/**
 * Candidats : commandes non terminales dont l'entrée dans l'état courant est
 * plus ancienne que le plus petit seuil. Une requête, l'historique lu par
 * `LATERAL` (index `OrderHistory(orderId)`).
 */
export async function loadStaleCandidates(
  prisma: PrismaService,
  now: Date,
  limit = 1000,
): Promise<StaleCandidate[]> {
  const cutoff = new Date(now.getTime() - MIN_THRESHOLD_MINUTES * 60_000);
  const statuses = SUPERVISED_ORDER_STATUSES;
  return prisma.$queryRaw<StaleCandidate[]>(Prisma.sql`
    SELECT o.id, o.status, o."isDelivery", o."scheduledFor", o."paidAt",
           o."updatedAt", r.nom AS "shopName",
           d."delivererId", d."pickedUpAt", h."enteredAt"
    FROM "Order" o
    JOIN "Restaurant" r ON r.id = o."restaurantId"
    LEFT JOIN "Delivery" d ON d."orderId" = o.id
    LEFT JOIN LATERAL (
      SELECT max(oh."createdAt") AS "enteredAt"
      FROM "OrderHistory" oh
      WHERE oh."orderId" = o.id AND oh."toStatus" = o.status
    ) h ON true
    WHERE o.status::text IN (${Prisma.join(statuses)})
      AND COALESCE(h."enteredAt", o."updatedAt") <= ${cutoff}
    ORDER BY COALESCE(h."enteredAt", o."updatedAt") ASC
    LIMIT ${limit}
  `);
}
