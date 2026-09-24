import { OpsBucket } from './ops-queue.service';
import {
  isQuietHours,
  OpsSlaScanService,
  paymentFailureRate,
  slaKey,
} from './ops-sla-scan.service';

/** Alerting métier du cockpit ops (F3-04). */
const NOON = new Date('2026-09-28T11:00:00.000Z'); // 12h00 à Brazzaville
const NIGHT = new Date('2026-09-28T01:00:00.000Z'); // 02h00 à Brazzaville

function bucket(key: OpsBucket['key'], ids: string[]): OpsBucket {
  return {
    key,
    label: key,
    severity: 'HIGH',
    count: ids.length,
    oldestAt: null,
    items: ids.map((id) => ({
      id,
      orderId: id,
      title: `Commande ${id}`,
      detail: null,
      since: NOON.toISOString(),
    })),
  };
}

function build({
  buckets = [] as OpsBucket[],
  openKeys = [] as string[],
  payments = [] as Array<{ status: string; _count: { _all: number } }>,
} = {}) {
  const prisma = {
    incident: {
      findMany: jest
        .fn()
        .mockResolvedValue(openKeys.map((dedupKey) => ({ dedupKey }))),
      createMany: jest
        .fn()
        .mockImplementation(({ data }) => ({ count: data.length })),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    payment: { groupBy: jest.fn().mockResolvedValue(payments) },
  };
  const queue = { queue: jest.fn().mockResolvedValue(buckets) };
  const alerts = { notify: jest.fn() };
  const config = {
    get: jest.fn().mockReturnValue('https://admin.liliafood.com/'),
  };
  const service = new OpsSlaScanService(
    prisma as never,
    queue as never,
    alerts as never,
    { runExclusively: jest.fn() } as never,
    config as never,
  );
  return { service, prisma, queue, alerts };
}

describe('OpsSlaScanService', () => {
  it('ouvre un incident par cause nouvelle, jamais pour une cause déjà ouverte (R-04.1)', async () => {
    const { service, prisma } = build({
      buckets: [
        bucket('acceptance_late', ['o1', 'o2']),
        bucket('refunds_pending', ['r1']),
      ],
      openKeys: [slaKey('acceptance_late', 'o1')],
    });
    const r = await service.scanUnlocked(NOON);

    expect(r.opened).toBe(1);
    const { data, skipDuplicates } =
      prisma.incident.createMany.mock.calls[0][0];
    expect(skipDuplicates).toBe(true);
    // o2 seul ; r1 appartient à une file non-SLA et n'ouvre rien.
    expect(data.map((d: { dedupKey: string }) => d.dedupKey)).toEqual([
      'ops:acceptance_late:o2',
    ]);
  });

  it('demande toutes les causes, pas seulement les 20 affichées', async () => {
    const { service, queue } = build();
    await service.scanUnlocked(NOON);
    expect(queue.queue).toHaveBeenCalledWith(NOON, { itemsPerBucket: 500 });
  });

  it('clôt les incidents dont la cause a disparu (R-04.2)', async () => {
    const { service, prisma } = build({
      buckets: [bucket('no_driver', ['o3'])],
    });
    await service.scanUnlocked(NOON);
    const resolveCall = prisma.incident.updateMany.mock.calls[0][0];
    expect(resolveCall.where.dedupKey).toEqual({
      startsWith: 'ops:',
      notIn: ['ops:no_driver:o3'],
    });
    expect(resolveCall.data).toMatchObject({
      status: 'RESOLVED',
      autoResolved: true,
    });
  });

  it('une seule alerte groupée par passage, lien vers /a-traiter', async () => {
    const { service, alerts } = build({
      buckets: [bucket('acceptance_late', ['o1', 'o2', 'o3'])],
    });
    await service.scanUnlocked(NOON);
    expect(alerts.notify).toHaveBeenCalledTimes(1);
    expect(alerts.notify.mock.calls[0][0]).toMatchObject({
      href: 'https://admin.liliafood.com/a-traiter',
      body: '• acceptance_late : 3',
    });
  });

  it('rien de nouveau : aucune alerte', async () => {
    const { service, alerts } = build({
      buckets: [bucket('acceptance_late', ['o1'])],
      openKeys: [slaKey('acceptance_late', 'o1')],
    });
    await service.scanUnlocked(NOON);
    expect(alerts.notify).not.toHaveBeenCalled();
  });

  it('la nuit, une carte non critique ne réveille personne (R-04.5)', async () => {
    const { service, alerts, prisma } = build({
      buckets: [bucket('acceptance_late', ['o1'])],
    });
    await service.scanUnlocked(NIGHT);
    expect(prisma.incident.createMany).toHaveBeenCalled(); // la carte existe
    expect(alerts.notify).not.toHaveBeenCalled();
  });

  it('échec de paiement anormal : incident CRITIQUE et alerte, même la nuit', async () => {
    const { service, alerts, prisma } = build({
      payments: [
        { status: 'FAILED', _count: { _all: 6 } },
        { status: 'SUCCESS', _count: { _all: 6 } },
      ],
    });
    const r = await service.scanUnlocked(NIGHT);
    expect(r.paymentOpened).toBe(true);
    const created = prisma.incident.createMany.mock.calls[0][0].data[0];
    expect(created).toMatchObject({
      type: 'METRIC_ANOMALY',
      severity: 'CRITICAL',
      dedupKey: 'metric:payment_failure',
    });
    expect(alerts.notify).toHaveBeenCalledTimes(1);
  });
});

describe('paymentFailureRate', () => {
  it('trop peu de tentatives : pas de conclusion', () => {
    expect(paymentFailureRate(4, 3)).toBeNull();
  });

  it('à partir de 10 tentatives : le taux', () => {
    expect(paymentFailureRate(10, 4)).toBe(0.4);
  });
});

describe('isQuietHours', () => {
  it.each([
    ['2026-09-28T21:59:00.000Z', false], // 22h59
    ['2026-09-28T22:00:00.000Z', true], // 23h00
    ['2026-09-29T05:59:00.000Z', true], // 06h59
    ['2026-09-29T06:00:00.000Z', false], // 07h00
  ])('%s → %s', (iso, quiet) => {
    expect(isQuietHours(new Date(iso))).toBe(quiet);
  });
});
