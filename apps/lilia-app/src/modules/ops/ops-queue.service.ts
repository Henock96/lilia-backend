import { Injectable } from '@nestjs/common';
import { IncidentSeverity, IncidentType, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Seuils des files « À traiter » (F3-04), en minutes. Valeurs de travail
 * (ASSUMED au blueprint) réunies ici, et nulle part ailleurs : la file, le scan
 * d'alerte et les tests lisent les mêmes.
 */
export const OPS_THRESHOLDS = {
  /** Payée et pas encore prise en charge (la moitié du délai d'acceptation D1 = 8 min). */
  acceptanceLateMinutes: 4,
  /** Acceptée ou prête, et toujours sans livreur. */
  noDriverMinutes: 10,
  /** En route depuis plus d'une heure. */
  enRouteMinutes: 60,
  /** Remboursement en attente depuis plus de 2 h. */
  refundPendingMinutes: 120,
  /** Réclamation client sans première réponse du support (F3-06). */
  claimUnansweredMinutes: 120,
  /**
   * Retrait remis par le vendeur seul, que le client n'a pas confirmé
   * (F3-07, D-P2). Escalade **opérationnelle** : elle ne paie rien, ne pose
   * aucune échéance (I-11) — un humain relance le client ou arbitre.
   */
  pickupUnconfirmedMinutes: 60,
} as const;

export type OpsBucketKey =
  | 'acceptance_late'
  | 'no_driver'
  | 'en_route_long'
  | 'delivery_failed'
  | 'refunds_pending'
  | 'claims_unanswered'
  | 'pickup_unconfirmed'
  | 'payouts_failed'
  | 'incidents_open'
  | 'outbox_failed';

export interface OpsItem {
  /** Identifiant de l'objet à traiter (commande, remboursement, incident…). */
  id: string;
  orderId: string | null;
  title: string;
  detail: string | null;
  /** Depuis quand la condition est vraie (au mieux de ce que la base sait). */
  since: string;
}

export interface OpsBucket {
  key: OpsBucketKey;
  label: string;
  severity: 'HIGH' | 'MEDIUM';
  count: number;
  oldestAt: string | null;
  items: OpsItem[];
}

/** Files qui ouvrent un incident système quand elles ne sont pas vides. */
export const SLA_BUCKETS: readonly OpsBucketKey[] = [
  'acceptance_late',
  'no_driver',
  'en_route_long',
  'delivery_failed',
];

const ITEMS_PER_BUCKET = 20;
const TERMINAL = ['LIVRER', 'ANNULER', 'ECHEC_LIVRAISON'] as const;

const minutesAgo = (now: Date, m: number) =>
  new Date(now.getTime() - m * 60_000);
const shortId = (id: string) => `#${id.slice(-6).toUpperCase()}`;

/**
 * « Ce qui doit être fait maintenant » (F3-04) — tout est **calculé**, rien
 * n'est saisi : une carte disparaît d'elle-même quand sa condition cesse
 * d'être vraie (R-04.2).
 *
 * Une requête par file (comptage + 20 plus anciens), toutes sur des colonnes
 * indexées ; aucune boucle par commande.
 */
@Injectable()
export class OpsQueueService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * `itemsPerBucket` : 20 pour l'écran ; le scan d'alerte en demande assez
   * pour voir toutes les causes (sinon il clôturerait à tort celles au-delà
   * de la vingtième).
   */
  async queue(
    now = new Date(),
    { itemsPerBucket = ITEMS_PER_BUCKET }: { itemsPerBucket?: number } = {},
  ): Promise<OpsBucket[]> {
    const t = OPS_THRESHOLDS;
    const orderSelect = {
      id: true,
      paidAt: true,
      updatedAt: true,
      restaurant: { select: { nom: true } },
    } as const;

    const acceptanceWhere: Prisma.OrderWhereInput = {
      status: 'PAYER',
      paidAt: { lte: minutesAgo(now, t.acceptanceLateMinutes) },
    };
    const noDriverWhere: Prisma.OrderWhereInput = {
      status: { in: ['ACCEPTEE' as const, 'PRET' as const] },
      isDelivery: true,
      updatedAt: { lte: minutesAgo(now, t.noDriverMinutes) },
      OR: [
        { delivery: { is: null } },
        { delivery: { is: { delivererId: null } } },
      ],
    };
    const enRouteWhere: Prisma.OrderWhereInput = {
      status: 'EN_ROUTE' as const,
      delivery: {
        is: { pickedUpAt: { lte: minutesAgo(now, t.enRouteMinutes) } },
      },
    };
    const failedDeliveryWhere: Prisma.DeliveryWhereInput = {
      status: 'ECHEC' as const,
      order: { status: { notIn: [...TERMINAL] } },
    };
    const refundWhere: Prisma.RefundWhereInput = {
      status: 'PENDING' as const,
      createdAt: { lte: minutesAgo(now, t.refundPendingMinutes) },
    };
    // F3-06 — une réclamation reste « OPEN » tant que le support n'a pas
    // répondu (sa première réponse la passe IN_PROGRESS).
    const claimWhere: Prisma.IncidentWhereInput = {
      type: IncidentType.CUSTOMER_CLAIM,
      status: 'OPEN' as const,
      createdAt: { lte: minutesAgo(now, t.claimUnansweredMinutes) },
    };
    // F3-07 / D-P2 — lecture seule, comme toutes les files : rien ici n'écrit
    // de preuve ni d'échéance de versement.
    const pickupUnconfirmedWhere: Prisma.OrderWhereInput = {
      status: 'LIVRER' as const,
      isDelivery: false,
      deliveryProof: 'PICKUP_VENDOR_DECLARED',
      deliveredAt: { lte: minutesAgo(now, t.pickupUnconfirmedMinutes) },
    };
    const incidentWhere: Prisma.IncidentWhereInput = {
      status: { in: ['OPEN' as const, 'IN_PROGRESS' as const] },
      severity: { in: [IncidentSeverity.HIGH, IncidentSeverity.CRITICAL] },
      // Les incidents ouverts par le scan décrivent les cartes ci-dessus : les
      // recompter ici afficherait chaque problème deux fois.
      type: { notIn: [IncidentType.OPS_SLA_BREACH] },
    };

    const take = itemsPerBucket;
    const [
      acceptance,
      noDriver,
      enRoute,
      failedDeliveries,
      refunds,
      claims,
      pickupsUnconfirmed,
      payouts,
      incidents,
      outbox,
    ] = await Promise.all([
      pair(
        this.prisma.order.count({ where: acceptanceWhere }),
        this.prisma.order.findMany({
          where: acceptanceWhere,
          orderBy: { paidAt: 'asc' },
          select: orderSelect,
          take,
        }),
      ),
      pair(
        this.prisma.order.count({ where: noDriverWhere }),
        this.prisma.order.findMany({
          where: noDriverWhere,
          orderBy: { updatedAt: 'asc' },
          select: orderSelect,
          take,
        }),
      ),
      pair(
        this.prisma.order.count({ where: enRouteWhere }),
        this.prisma.order.findMany({
          where: enRouteWhere,
          orderBy: { updatedAt: 'asc' },
          select: {
            ...orderSelect,
            delivery: { select: { pickedUpAt: true } },
          },
          take,
        }),
      ),
      pair(
        this.prisma.delivery.count({ where: failedDeliveryWhere }),
        this.prisma.delivery.findMany({
          where: failedDeliveryWhere,
          orderBy: { updatedAt: 'asc' },
          select: {
            id: true,
            orderId: true,
            updatedAt: true,
            order: { select: { restaurant: { select: { nom: true } } } },
          },
          take,
        }),
      ),
      pair(
        this.prisma.refund.count({ where: refundWhere }),
        this.prisma.refund.findMany({
          where: refundWhere,
          orderBy: { createdAt: 'asc' },
          select: { id: true, orderId: true, amount: true, createdAt: true },
          take,
        }),
      ),
      pair(
        this.prisma.incident.count({ where: claimWhere }),
        this.prisma.incident.findMany({
          where: claimWhere,
          orderBy: { createdAt: 'asc' },
          select: {
            id: true,
            orderId: true,
            title: true,
            description: true,
            createdAt: true,
          },
          take,
        }),
      ),
      pair(
        this.prisma.order.count({ where: pickupUnconfirmedWhere }),
        this.prisma.order.findMany({
          where: pickupUnconfirmedWhere,
          orderBy: { deliveredAt: 'asc' },
          select: { ...orderSelect, deliveredAt: true },
          take,
        }),
      ),
      pair(
        this.prisma.restaurantPayout.count({ where: { status: 'FAILED' } }),
        this.prisma.restaurantPayout.findMany({
          where: { status: 'FAILED' },
          orderBy: { updatedAt: 'asc' },
          select: {
            id: true,
            orderId: true,
            amount: true,
            failureMessage: true,
            updatedAt: true,
            restaurant: { select: { nom: true } },
          },
          take,
        }),
      ),
      pair(
        this.prisma.incident.count({ where: incidentWhere }),
        this.prisma.incident.findMany({
          where: incidentWhere,
          orderBy: { createdAt: 'asc' },
          select: {
            id: true,
            orderId: true,
            title: true,
            severity: true,
            createdAt: true,
          },
          take,
        }),
      ),
      pair(
        this.prisma.outboxEvent.count({ where: { status: 'FAILED' } }),
        this.prisma.outboxEvent.findMany({
          where: { status: 'FAILED' },
          orderBy: { updatedAt: 'asc' },
          select: {
            id: true,
            type: true,
            aggregateId: true,
            lastError: true,
            updatedAt: true,
          },
          take,
        }),
      ),
    ]);

    return [
      bucket(
        'acceptance_late',
        'Payées, pas encore prises en charge',
        'HIGH',
        acceptance,
        (o) => ({
          id: o.id,
          orderId: o.id,
          title: `Commande ${shortId(o.id)} — ${o.restaurant.nom}`,
          detail: 'Le vendeur n’a pas encore accepté.',
          since: iso(o.paidAt ?? o.updatedAt),
        }),
      ),
      bucket('no_driver', 'Sans livreur', 'HIGH', noDriver, (o) => ({
        id: o.id,
        orderId: o.id,
        title: `Commande ${shortId(o.id)} — ${o.restaurant.nom}`,
        detail: 'Aucun livreur assigné.',
        since: iso(o.updatedAt),
      })),
      bucket(
        'en_route_long',
        'En route depuis plus d’une heure',
        'HIGH',
        enRoute,
        (o) => ({
          id: o.id,
          orderId: o.id,
          title: `Commande ${shortId(o.id)} — ${o.restaurant.nom}`,
          detail: 'Livraison anormalement longue.',
          since: iso(o.delivery?.pickedUpAt ?? o.updatedAt),
        }),
      ),
      bucket(
        'delivery_failed',
        'Livraisons en échec à arbitrer',
        'HIGH',
        failedDeliveries,
        (d) => ({
          id: d.id,
          orderId: d.orderId,
          title: `Commande ${shortId(d.orderId)} — ${d.order.restaurant.nom}`,
          detail: 'Réassigner ou conclure l’échec.',
          since: iso(d.updatedAt),
        }),
      ),
      bucket(
        'refunds_pending',
        'Remboursements en attente',
        'MEDIUM',
        refunds,
        (r) => ({
          id: r.id,
          orderId: r.orderId,
          title: `Remboursement de ${r.amount} FCFA — commande ${shortId(r.orderId)}`,
          detail: null,
          since: iso(r.createdAt),
        }),
      ),
      bucket(
        'claims_unanswered',
        'Réclamations sans réponse depuis 2 h',
        'MEDIUM',
        claims,
        (c) => ({
          id: c.id,
          orderId: c.orderId,
          title: c.title,
          detail: c.description,
          since: iso(c.createdAt),
        }),
      ),
      bucket(
        'pickup_unconfirmed',
        'Retraits non confirmés par le client',
        'MEDIUM',
        pickupsUnconfirmed,
        (o) => ({
          id: o.id,
          orderId: o.id,
          title: `Commande ${shortId(o.id)} — ${o.restaurant.nom}`,
          detail:
            'Remise déclarée par le vendeur, sans confirmation du client : aucun versement automatique. Relancer le client, ou arbitrer.',
          since: iso(o.deliveredAt ?? o.updatedAt),
        }),
      ),
      bucket(
        'payouts_failed',
        'Reversements en échec',
        'MEDIUM',
        payouts,
        (p) => ({
          id: p.id,
          orderId: p.orderId,
          title: `Reversement de ${p.amount} FCFA — ${p.restaurant.nom}`,
          detail: p.failureMessage,
          since: iso(p.updatedAt),
        }),
      ),
      bucket(
        'incidents_open',
        'Incidents graves ouverts',
        'HIGH',
        incidents,
        (i) => ({
          id: i.id,
          orderId: i.orderId,
          title: i.title,
          detail: i.severity,
          since: iso(i.createdAt),
        }),
      ),
      bucket(
        'outbox_failed',
        'Notifications abandonnées',
        'MEDIUM',
        outbox,
        (e) => ({
          id: e.id,
          orderId: null,
          title: `${e.type} (${shortId(e.aggregateId)})`,
          detail: e.lastError ? e.lastError.slice(0, 200) : null,
          since: iso(e.updatedAt),
        }),
      ),
    ];
  }

  /** Nombre total de cartes — le badge de la barre latérale. */
  async total(now = new Date()): Promise<number> {
    const buckets = await this.queue(now);
    return buckets.reduce((sum, b) => sum + b.count, 0);
  }
}

async function pair<T>(
  count: Promise<number>,
  rows: Promise<T[]>,
): Promise<{ count: number; rows: T[] }> {
  const [c, r] = await Promise.all([count, rows]);
  return { count: c, rows: r };
}

function iso(d: Date): string {
  return d.toISOString();
}

function bucket<T>(
  key: OpsBucketKey,
  label: string,
  severity: 'HIGH' | 'MEDIUM',
  page: { count: number; rows: T[] },
  toItem: (row: T) => OpsItem,
): OpsBucket {
  const items = page.rows.map(toItem);
  return {
    key,
    label,
    severity,
    count: page.count,
    oldestAt: items[0]?.since ?? null,
    items,
  };
}
