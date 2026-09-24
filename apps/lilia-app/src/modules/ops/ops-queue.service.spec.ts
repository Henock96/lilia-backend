import { OPS_THRESHOLDS, OpsQueueService } from './ops-queue.service';

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
    });
  });

  it('huit files, dans l’ordre de l’écran', async () => {
    const { service } = build();
    const buckets = await service.queue(NOW);
    expect(buckets.map((b) => b.key)).toEqual([
      'acceptance_late',
      'no_driver',
      'en_route_long',
      'delivery_failed',
      'refunds_pending',
      'payouts_failed',
      'incidents_open',
      'outbox_failed',
    ]);
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
    // Les incidents ouverts par le scan décrivent déjà les cartes : exclus.
    expect(prisma.incident.count.mock.calls[0][0].where.type).toEqual({
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
});
