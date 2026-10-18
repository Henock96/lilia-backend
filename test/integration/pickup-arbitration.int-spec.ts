import { PrismaPg } from '@prisma/adapter-pg';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { OrderStatus, PrismaClient } from '@prisma/client';

import { OrderLifecycleService } from '../../apps/lilia-app/src/modules/orders/order-lifecycle.service';
import { OrderStateMachine } from '../../apps/lilia-app/src/modules/orders/order-state.machine';
import { OrderTransitionService } from '../../apps/lilia-app/src/modules/orders/order-transition.service';
import { StockService } from '../../apps/lilia-app/src/modules/orders/stock.service';
import { OutboxService } from '../../apps/lilia-app/src/modules/outbox/outbox.service';

/**
 * **1B (ADM-03, D-1) — la remise forcée d'un retrait par l'ADMIN est un
 * arbitrage motivé.**
 *
 * `PICKUP_ADMIN_OVERRIDE` ouvre une échéance de versement vendeur
 * (`Order_payoutDueAt_needs_proof`) : le geste doit porter un motif, laisser une
 * trace d'audit **dans la même transaction** que la clôture, et — une fois
 * `ADMIN_PICKUP_ARBITRATION_ENFORCED` allumé — ne plus passer par la route de
 * statut générique, qu'aucune capacité ne protège.
 */
const DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

describeIfDb('1B — arbitrage de remise ADMIN (PostgreSQL réel)', () => {
  let prisma: PrismaClient;
  const events = new EventEmitter2();
  let enforced = false;

  const OWNER_UID = 'fb-arb-owner';
  const ADMIN_UID = 'fb-arb-admin';
  const ORDER = 'arb-order';

  function lifecycle() {
    return new OrderLifecycleService(
      prisma as never,
      events,
      new OrderStateMachine(),
      new OrderTransitionService(),
      new StockService(),
      { awardForDeliveredOrder: async () => 0 } as never,
      { rewardForDeliveredOrder: async () => undefined } as never,
      { openForCancelledOrder: async () => null } as never,
      { record: async () => undefined } as never,
      new OutboxService(prisma as never),
      { announce: async () => undefined } as never,
      {
        get: (k: string) =>
          k === 'ADMIN_PICKUP_ARBITRATION_ENFORCED' ? enforced : undefined,
      } as never,
    );
  }

  beforeAll(async () => {
    prisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: DATABASE_URL }),
    });
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    enforced = false;
    await prisma.$executeRawUnsafe(`
      TRUNCATE TABLE "AdminAuditLog", "PickupHandover", "OutboxEvent",
                     "OrderItem", "OrderHistory", "Order", "Restaurant",
                     "User", "PlatformSettings"
      RESTART IDENTITY CASCADE
    `);
    await prisma.user.createMany({
      data: [
        {
          id: 'arb-owner',
          firebaseUid: OWNER_UID,
          email: 'arb-o@test.local',
          role: 'RESTAURATEUR',
        },
        {
          id: 'arb-client',
          firebaseUid: 'fb-arb-client',
          email: 'arb-c@test.local',
        },
        {
          id: 'arb-admin',
          firebaseUid: ADMIN_UID,
          email: 'arb-a@test.local',
          role: 'ADMIN',
        },
      ],
    });
    await prisma.restaurant.create({
      data: {
        id: 'arb-vendor',
        nom: 'Chez Arbitre',
        adresse: 'Bacongo',
        phone: '060000060',
        ownerId: 'arb-owner',
      },
    });
  });

  async function createOrder(
    status: OrderStatus,
    opts: { id?: string; isDelivery?: boolean } = {},
  ) {
    await prisma.order.create({
      data: {
        id: opts.id ?? ORDER,
        restaurantId: 'arb-vendor',
        userId: 'arb-client',
        subTotal: 4000,
        deliveryFee: 0,
        deliveryFeeGross: 0,
        total: 4000,
        paymentMethod: 'MTN_MOMO',
        isDelivery: opts.isDelivery ?? false,
        status,
      },
    });
  }
  const readOrder = (id = ORDER) =>
    prisma.order.findUniqueOrThrow({ where: { id } });
  const auditRows = () =>
    prisma.adminAuditLog.findMany({
      where: { targetId: ORDER, action: 'ORDER_STATUS_FORCED' },
    });
  const arbitration = {
    reason: 'CUSTOMER_COLLECTED_NO_CODE' as const,
    note: 'Téléphone du client déchargé',
  };

  it('arbitrage motivé : LIVRER, preuve admin, échéance, journal motivé écrit avec la clôture', async () => {
    await createOrder(OrderStatus.PRET);

    await lifecycle().arbitratePickup(ORDER, ADMIN_UID, arbitration);

    const order = await readOrder();
    expect(order.status).toBe('LIVRER');
    expect(order.deliveryProof).toBe('PICKUP_ADMIN_OVERRIDE');
    expect(order.payoutDueAt).not.toBeNull();
    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorId: 'arb-admin' });
    expect(rows[0].metadata).toMatchObject({
      from: 'PRET',
      to: 'LIVRER',
      kind: 'PICKUP_ARBITRATION',
      reason: 'CUSTOMER_COLLECTED_NO_CODE',
      note: 'Téléphone du client déchargé',
    });
    const history = await prisma.orderHistory.findFirstOrThrow({
      where: { orderId: ORDER, toStatus: 'LIVRER' },
    });
    expect(history.reason).toContain('CUSTOMER_COLLECTED_NO_CODE');
  });

  it('interrupteur allumé : la route de statut refuse la remise ADMIN d’un retrait, rien n’est écrit', async () => {
    await createOrder(OrderStatus.PRET);
    enforced = true;

    await expect(
      lifecycle().updateOrderStatusByRestaurateur(ORDER, ADMIN_UID, 'LIVRER'),
    ).rejects.toMatchObject({
      response: { code: 'PICKUP_ARBITRATION_REQUIRED' },
    });
    expect((await readOrder()).status).toBe('PRET');
    expect(await auditRows()).toHaveLength(0);
  });

  it('interrupteur éteint (transition) : l’ancien chemin reste ouvert aux apps installées', async () => {
    await createOrder(OrderStatus.PRET);

    await lifecycle().updateOrderStatusByRestaurateur(
      ORDER,
      ADMIN_UID,
      'LIVRER',
    );

    expect((await readOrder()).deliveryProof).toBe('PICKUP_ADMIN_OVERRIDE');
  });

  it('interrupteur allumé : le vendeur remet toujours son retrait par la route de statut', async () => {
    await createOrder(OrderStatus.PRET);
    enforced = true;

    await lifecycle().updateOrderStatusByRestaurateur(
      ORDER,
      OWNER_UID,
      'LIVRER',
    );

    expect((await readOrder()).deliveryProof).toBe('PICKUP_VENDOR_DECLARED');
  });

  it('une livraison à domicile ne s’arbitre pas ici : 409, rien n’est écrit', async () => {
    await createOrder(OrderStatus.PRET, { isDelivery: true });

    await expect(
      lifecycle().arbitratePickup(ORDER, ADMIN_UID, arbitration),
    ).rejects.toMatchObject({ response: { code: 'PICKUP_NOT_APPLICABLE' } });
    expect((await readOrder()).status).toBe('PRET');
  });

  it('un vendeur ne peut pas arbitrer, même sa propre commande', async () => {
    await createOrder(OrderStatus.PRET);

    await expect(
      lifecycle().arbitratePickup(ORDER, OWNER_UID, arbitration),
    ).rejects.toMatchObject({ status: 403 });
    expect((await readOrder()).status).toBe('PRET');
  });

  it('commande pas encore prête : refus de la machine d’états, rien n’est écrit', async () => {
    await createOrder(OrderStatus.EN_PREPARATION);

    await expect(
      lifecycle().arbitratePickup(ORDER, ADMIN_UID, arbitration),
    ).rejects.toMatchObject({ status: 400 });
    expect((await readOrder()).status).toBe('EN_PREPARATION');
    expect(await auditRows()).toHaveLength(0);
  });

  it('deux arbitrages simultanés : une seule clôture, une seule ligne de journal', async () => {
    await createOrder(OrderStatus.PRET);

    const results = await Promise.allSettled([
      lifecycle().arbitratePickup(ORDER, ADMIN_UID, arbitration),
      lifecycle().arbitratePickup(ORDER, ADMIN_UID, arbitration),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(
      await prisma.orderHistory.count({
        where: { orderId: ORDER, toStatus: 'LIVRER' },
      }),
    ).toBe(1);
    expect(await auditRows()).toHaveLength(1);
  });
});
