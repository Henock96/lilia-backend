import {
  OPS_THRESHOLDS,
  OpsQueueService,
  SLA_BUCKETS,
} from './ops-queue.service';

/**
 * Files « À traiter » (F3-04) : les conditions envoyées à la base. Chaque
 * seuil a sa ligne écrite à la main — une spec qui relirait OPS_THRESHOLDS
 * pour calculer ses attentes ne prouverait rien.
 */
const NOW = new Date('2026-09-28T11:00:00.000Z');
const ago = (min: number) => new Date(NOW.getTime() - min * 60_000);

function build() {
  const delegate = () => ({
    count: jest.fn().mockResolvedValue(0),
    findMany: jest.fn().mockResolvedValue([]),
  });
  const prisma = {
    order: delegate(),
    delivery: delegate(),
    refund: delegate(),
    restaurantPayout: delegate(),
    incident: delegate(),
    outboxEvent: delegate(),
    // Point 6 — commandes immobiles, lues par une requête SQL.
    $queryRaw: jest.fn().mockResolvedValue([]),
  };
  return { service: new OpsQueueService(prisma as never), prisma };
}

describe('OpsQueueService', () => {
  it('les seuils de travail', () => {
    expect(OPS_THRESHOLDS).toEqual({
      acceptanceLateMinutes: 4,
      noDriverMinutes: 10,
      enRouteMinutes: 60,
      refundPendingMinutes: 120,
      claimUnansweredMinutes: 120,
      pickupUnconfirmedMinutes: 60,
    });
  });

  it('quatorze files, dans l’ordre de l’écran', async () => {
    const { service } = build();
    const buckets = await service.queue(NOW);
    expect(buckets.map((b) => b.key)).toEqual([
      'acceptance_late',
      'no_driver',
      'en_route_long',
      'delivery_failed',
      'refunds_pending',
      'claims_unanswered',
      'pickup_unconfirmed',
      'payouts_failed',
      'incidents_open',
      'outbox_failed',
      // Audit du 28/10/2026, point 6.
      'order_stale',
      'payouts_in_flight',
      'refunds_in_flight',
      'claims_stalled',
    ]);
  });

  it('point 6 — argent en vol et réclamations immobiles : conditions', async () => {
    const { service, prisma } = build();
    await service.queue(NOW);
    expect(
      prisma.restaurantPayout.count.mock.calls.map((c) => c[0].where),
    ).toContainEqual({
      status: 'PENDING',
      requestedAt: { lte: ago(30) },
    });
    expect(
      prisma.refund.count.mock.calls.map((c) => c[0].where),
    ).toContainEqual({
      status: 'PROCESSING',
      updatedAt: { lte: ago(30) },
    });
    expect(
      prisma.incident.count.mock.calls.map((c) => c[0].where),
    ).toContainEqual({
      type: 'CUSTOMER_CLAIM',
      status: 'IN_PROGRESS',
      updatedAt: { lte: ago(24 * 60) },
    });
  });

  it('point 6 — une commande immobile apparaît une seule fois, avec son action', async () => {
    const { service, prisma } = build();
    prisma.$queryRaw.mockResolvedValue([
      {
        id: 'o-prep',
        status: 'EN_PREPARATION',
        isDelivery: true,
        scheduledFor: null,
        paidAt: ago(80),
        updatedAt: ago(1), // une écriture sans rapport ne remet rien à zéro
        shopName: 'Chez Awa',
        delivererId: null,
        pickedUpAt: null,
        enteredAt: ago(50),
      },
      {
        // Déjà dans « acceptance_late » : pas de doublon.
        id: 'o-paid',
        status: 'PAYER',
        isDelivery: true,
        scheduledFor: null,
        paidAt: ago(20),
        updatedAt: ago(20),
        shopName: 'Chez Awa',
        delivererId: null,
        pickedUpAt: null,
        enteredAt: ago(20),
      },
    ]);
    const buckets = await service.queue(NOW);
    const stale = buckets.find((b) => b.key === 'order_stale')!;
    expect(stale.count).toBe(1);
    expect(stale.items[0]).toMatchObject({
      id: 'o-prep@EN_PREPARATION',
      orderId: 'o-prep',
      since: ago(50).toISOString(),
    });
    expect(SLA_BUCKETS).toContain('order_stale');
  });

  it('conditions par file', async () => {
    const { service, prisma } = build();
    await service.queue(NOW);
    const orderWheres = prisma.order.count.mock.calls.map((c) => c[0].where);

    expect(orderWheres[0]).toEqual({
      status: 'PAYER',
      paidAt: { lte: ago(4) },
    });
    expect(orderWheres[1]).toMatchObject({
      status: { in: ['ACCEPTEE', 'PRET'] },
      isDelivery: true,
      updatedAt: { lte: ago(10) },
    });
    expect(orderWheres[2]).toEqual({
      status: 'EN_ROUTE',
      delivery: { is: { pickedUpAt: { lte: ago(60) } } },
    });
    expect(prisma.delivery.count.mock.calls[0][0].where).toEqual({
      status: 'ECHEC',
      order: { status: { notIn: ['LIVRER', 'ANNULER', 'ECHEC_LIVRAISON'] } },
    });
    expect(prisma.refund.count.mock.calls[0][0].where).toEqual({
      status: 'PENDING',
      createdAt: { lte: ago(120) },
    });
    // F3-06 — réclamation sans première réponse depuis 2 h.
    expect(prisma.incident.count.mock.calls[0][0].where).toEqual({
      type: 'CUSTOMER_CLAIM',
      status: 'OPEN',
      createdAt: { lte: ago(120) },
    });
    // F3-07 / D-P2 — retrait remis par le vendeur seul, non confirmé depuis 1 h.
    expect(orderWheres[3]).toEqual({
      status: 'LIVRER',
      isDelivery: false,
      deliveryProof: 'PICKUP_VENDOR_DECLARED',
      deliveredAt: { lte: ago(60) },
    });
    // Les incidents ouverts par le scan décrivent déjà les cartes : exclus.
    expect(prisma.incident.count.mock.calls[1][0].where.type).toEqual({
      notIn: ['OPS_SLA_BREACH'],
    });
  });

  it('20 éléments par file à l’écran, le plus ancien en tête', async () => {
    const { service, prisma } = build();
    prisma.order.count.mockResolvedValueOnce(42);
    prisma.order.findMany.mockResolvedValueOnce([
      {
        id: 'cmorder000001abcdef',
        paidAt: ago(30),
        updatedAt: ago(30),
        restaurant: { nom: 'Chez Lili' },
      },
    ]);
    const [acceptance] = await service.queue(NOW);
    expect(prisma.order.findMany.mock.calls[0][0].take).toBe(20);
    expect(acceptance).toMatchObject({
      count: 42,
      oldestAt: ago(30).toISOString(),
      items: [
        {
          orderId: 'cmorder000001abcdef',
          title: 'Commande #ABCDEF — Chez Lili',
        },
      ],
    });
  });

  it('I-11 — l’escalade des retraits non confirmés est une lecture, jamais une écriture', async () => {
    const { service, prisma } = build();
    const writes = {
      update: jest.fn(),
      updateMany: jest.fn(),
      create: jest.fn(),
    };
    Object.assign(prisma.order, writes);
    Object.assign(prisma.restaurantPayout, writes);
    await service.queue(NOW);
    for (const fn of Object.values(writes)) expect(fn).not.toHaveBeenCalled();
  });

  it('le retrait non confirmé n’ouvre pas d’incident SLA : c’est une relance, pas une panne', () => {
    expect(SLA_BUCKETS).not.toContain('pickup_unconfirmed');
  });
});
