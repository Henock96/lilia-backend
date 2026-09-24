import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { DeliveryFailureService } from './delivery-failure.service';
import {
  clientLiabilityGaps,
  FAILURE_OUTCOMES,
  FailureEvidence,
} from './delivery-failure.policy';

/**
 * Échec de livraison (F3-05). La matrice est écrite ici à la main : une spec
 * qui relirait FAILURE_OUTCOMES pour calculer ses attentes ne prouverait rien.
 */
describe('matrice de responsabilité (R-05.3, D10)', () => {
  it.each([
    ['CLIENT', { refundClient: false, payVendor: true, payDriver: true }],
    ['DRIVER', { refundClient: true, payVendor: true, payDriver: false }],
    ['VENDOR', { refundClient: true, payVendor: false, payDriver: true }],
    ['PLATFORM', { refundClient: true, payVendor: true, payDriver: true }],
  ] as const)('%s', (liability, expected) => {
    expect(FAILURE_OUTCOMES[liability]).toEqual(expected);
  });
});

describe('clientLiabilityGaps (R-05.4)', () => {
  const t0 = new Date('2026-09-28T12:00:00.000Z');
  const complete: FailureEvidence = {
    reason: 'CUSTOMER_UNREACHABLE',
    callAttempts: 2,
    smsSentAt: t0,
    protocolStartedAt: t0,
    declaredAt: new Date(t0.getTime() + 10 * 60_000),
    distanceToDestM: 120,
  };

  it('protocole complet : le client peut répondre', () => {
    expect(clientLiabilityGaps(complete, true)).toEqual([]);
  });

  it('refus à la porte : le client répond sans protocole', () => {
    expect(
      clientLiabilityGaps(
        { ...complete, reason: 'CUSTOMER_REFUSED', callAttempts: 0 },
        true,
      ),
    ).toEqual([]);
  });

  it('un seul appel, pas de SMS, 9 min, 450 m : chaque manque est nommé', () => {
    const gaps = clientLiabilityGaps(
      {
        ...complete,
        callAttempts: 1,
        smsSentAt: null,
        declaredAt: new Date(t0.getTime() + 9 * 60_000),
        distanceToDestM: 450,
      },
      true,
    );
    expect(gaps).toHaveLength(4);
  });

  it('destination approximative : la distance ne prouve rien, elle n’est pas exigée', () => {
    expect(
      clientLiabilityGaps({ ...complete, distanceToDestM: null }, false),
    ).toEqual([]);
  });

  it('adresse introuvable : jamais le client (géocodage de Brazzaville)', () => {
    expect(
      clientLiabilityGaps({ ...complete, reason: 'ADDRESS_NOT_FOUND' }, true),
    ).not.toEqual([]);
  });
});

// ─── Service ─────────────────────────────────────────────────────────────────

const ADMIN = { id: 'admin', role: 'ADMIN' } as never;
const DRIVER = { id: 'drv', role: 'LIVREUR' } as never;
const VENDOR = { id: 'owner', role: 'RESTAURATEUR' } as never;

function makeOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: 'o1',
    status: 'EN_ROUTE',
    userId: 'client',
    restaurantId: 'r1',
    total: 6000,
    deliveryPrecision: 'EXACT',
    restaurant: { nom: 'Chez Lili' },
    Payment: [{ id: 'pay1', amount: 6000 }],
    payout: null,
    refund: null,
    delivery: {
      id: 'd1',
      status: 'ECHEC',
      driverPayXaf: 700,
      failureReports: [
        {
          reason: 'CUSTOMER_UNREACHABLE',
          callAttempts: 0,
          smsSentAt: null,
          protocolStartedAt: null,
          declaredAt: new Date(),
          distanceToDestM: null,
        },
      ],
    },
    ...overrides,
  };
}

function build(order: unknown = makeOrder(), delivery: unknown = null) {
  const tx = {
    delivery: {
      update: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    refund: { create: jest.fn() },
    user: { updateMany: jest.fn() },
    deliveryFailureReport: { create: jest.fn(), update: jest.fn() },
  };
  const prisma = {
    order: { findUnique: jest.fn().mockResolvedValue(order) },
    delivery: { findUnique: jest.fn().mockResolvedValue(delivery) },
    deliveryFailureReport: { findFirst: jest.fn().mockResolvedValue(null) },
    $transaction: jest.fn((fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  const transitions = { transition: jest.fn() };
  const events = { emit: jest.fn() };
  const audit = { record: jest.fn() };
  const service = new DeliveryFailureService(
    prisma as never,
    transitions as never,
    { close: jest.fn() } as never,
    audit as never,
    { send: jest.fn().mockResolvedValue('SENT') } as never,
    { sendPushNotification: jest.fn().mockResolvedValue(undefined) } as never,
    events as never,
  );
  return { service, prisma, tx, transitions, events, audit };
}

describe('DeliveryFailureService.conclude', () => {
  it('client injoignable sans protocole : CLIENT refusé, la plateforme assume', async () => {
    const { service, transitions } = build();
    await expect(
      service.conclude('o1', ADMIN, 'CLIENT', false),
    ).rejects.toThrow(ConflictException);
    expect(transitions.transition).not.toHaveBeenCalled();
  });

  it('dryRun : les montants, aucune écriture', async () => {
    const { service, prisma, audit } = build();
    const r = await service.conclude('o1', ADMIN, 'DRIVER', true);
    expect(r).toMatchObject({
      dryRun: true,
      refundXaf: 6000,
      driverPayXaf: 0,
      vendorPaid: true,
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('DRIVER : commande ECHEC_LIVRAISON, client remboursé, paie livreur à 0', async () => {
    const { service, tx, transitions, events } = build();
    await service.conclude('o1', ADMIN, 'DRIVER', false);

    expect(transitions.transition.mock.calls[0][1]).toMatchObject({
      from: 'EN_ROUTE',
      to: 'ECHEC_LIVRAISON',
      actor: 'ADMIN',
      data: {
        failureLiability: 'DRIVER',
        failureReason: 'CUSTOMER_UNREACHABLE',
      },
    });
    expect(tx.delivery.update).toHaveBeenCalledWith({
      where: { id: 'd1' },
      data: { driverPayXaf: 0 },
    });
    expect(tx.refund.create.mock.calls[0][0].data).toMatchObject({
      orderId: 'o1',
      amount: 6000,
      status: 'PENDING',
    });
    expect(events.emit).toHaveBeenCalledWith(
      'order.status.updated',
      expect.anything(),
    );
  });

  it('PLATFORM : remboursé, livreur payé (sa paie n’est pas touchée)', async () => {
    const { service, tx } = build();
    await service.conclude('o1', ADMIN, 'PLATFORM', false);
    expect(tx.delivery.update).not.toHaveBeenCalled();
    expect(tx.refund.create).toHaveBeenCalled();
  });

  it('CLIENT avec protocole complet : ni remboursement, ni retenue', async () => {
    const t0 = new Date('2026-09-28T12:00:00.000Z');
    const order = makeOrder({
      delivery: {
        id: 'd1',
        status: 'ECHEC',
        driverPayXaf: 700,
        failureReports: [
          {
            reason: 'CUSTOMER_UNREACHABLE',
            callAttempts: 3,
            smsSentAt: t0,
            protocolStartedAt: t0,
            declaredAt: new Date(t0.getTime() + 12 * 60_000),
            distanceToDestM: 80,
          },
        ],
      },
    });
    const { service, tx } = build(order);
    const r = await service.conclude('o1', ADMIN, 'CLIENT', false);
    expect(r.refundXaf).toBe(0);
    expect(tx.refund.create).not.toHaveBeenCalled();
    expect(tx.delivery.update).not.toHaveBeenCalled();
  });

  it('VENDOR déjà payé : refus (pas de clawback avant F3-07)', async () => {
    const { service } = build(makeOrder({ payout: { status: 'SUCCESS' } }));
    await expect(
      service.conclude('o1', ADMIN, 'VENDOR', false),
    ).rejects.toThrow(ConflictException);
  });

  it('reversement en vol : on ne tranche pas (F-04)', async () => {
    const { service } = build(makeOrder({ payout: { status: 'PENDING' } }));
    await expect(
      service.conclude('o1', ADMIN, 'PLATFORM', false),
    ).rejects.toThrow(ConflictException);
  });

  it('aucun échec déclaré : réassigner ou déclarer d’abord', async () => {
    const order = makeOrder();
    (order.delivery as { status: string }).status = 'EN_TRANSIT';
    const { service } = build(order);
    await expect(
      service.conclude('o1', ADMIN, 'PLATFORM', false),
    ).rejects.toThrow(ConflictException);
  });
});

describe('DeliveryFailureService.declare', () => {
  function delivery(status: string, delivererId: string | null = 'drv') {
    return {
      id: 'd1',
      orderId: 'o1',
      status,
      delivererId,
      order: {
        userId: 'client',
        restaurantId: 'r1',
        deliveryLatitude: -4.26,
        deliveryLongitude: 15.27,
        restaurant: { nom: 'Chez Lili', owner: { id: 'owner' } },
      },
    };
  }

  it('le vendeur ne déclare plus une course partie avec le livreur (P3)', async () => {
    const { service } = build(undefined, delivery('EN_TRANSIT'));
    await expect(
      service.declare('d1', VENDOR, { reason: 'OTHER' }),
    ).rejects.toThrow(ForbiddenException);
  });

  it('le vendeur déclare « personne n’est venu » avant récupération : livreur détaché, sans paie', async () => {
    const { service, tx } = build(undefined, delivery('ASSIGNER'));
    await service.declare('d1', VENDOR, { reason: 'DRIVER_NO_SHOW' });
    expect(tx.delivery.updateMany.mock.calls[0][0].data).toMatchObject({
      status: 'ECHEC',
      delivererId: null,
      driverPayXaf: null,
    });
  });

  it('le livreur en course garde sa paie gelée jusqu’à la conclusion', async () => {
    const { service, tx } = build(undefined, delivery('EN_TRANSIT'));
    const r = await service.declare('d1', DRIVER, {
      reason: 'LOST_OR_DAMAGED',
      latitude: -4.26,
      longitude: 15.27,
    });
    const data = tx.delivery.updateMany.mock.calls[0][0].data;
    expect(data.status).toBe('ECHEC');
    expect(data).not.toHaveProperty('delivererId');
    expect(data).not.toHaveProperty('driverPayXaf');
    expect(r.distanceToDestM).toBe(0);
  });

  it('« client injoignable » sans protocole démarré : refusé au livreur', async () => {
    const { service } = build(undefined, delivery('EN_TRANSIT'));
    await expect(
      service.declare('d1', DRIVER, { reason: 'CUSTOMER_UNREACHABLE' }),
    ).rejects.toThrow(BadRequestException);
  });

  it('« client injoignable » avant 10 min d’attente : refusé au livreur', async () => {
    const { service, prisma } = build(undefined, delivery('EN_TRANSIT'));
    prisma.deliveryFailureReport.findFirst.mockResolvedValue({
      id: 'rep1',
      protocolStartedAt: new Date(Date.now() - 4 * 60_000),
    });
    await expect(
      service.declare('d1', DRIVER, { reason: 'CUSTOMER_UNREACHABLE' }),
    ).rejects.toThrow(/Attendez encore 6 min/);
  });

  it('course déjà livrée : plus d’échec possible', async () => {
    const { service } = build(undefined, delivery('LIVRER'));
    await expect(
      service.declare('d1', ADMIN, { reason: 'OTHER' }),
    ).rejects.toThrow(ConflictException);
  });
});
