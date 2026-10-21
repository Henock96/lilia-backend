import { PrismaPg } from '@prisma/adapter-pg';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { OrderStatus, PrismaClient } from '@prisma/client';

import { OrderLifecycleService } from '../../apps/lilia-app/src/modules/orders/order-lifecycle.service';
import { OrderStateMachine } from '../../apps/lilia-app/src/modules/orders/order-state.machine';
import { OrderTransitionService } from '../../apps/lilia-app/src/modules/orders/order-transition.service';
import { StockService } from '../../apps/lilia-app/src/modules/orders/stock.service';
import { OutboxService } from '../../apps/lilia-app/src/modules/outbox/outbox.service';

/**
 * **Lot 2 (ADM-09) — une annulation dit pourquoi.**
 *
 * Annuler une commande en préparation (ADMIN ou vendeur) ouvre un
 * remboursement ; l'historique n'en gardait que « Annulation par admin ». Le
 * motif, facultatif pour ne casser aucune application installée, entre dans
 * `OrderHistory.reason` et, pour l'ADMIN, dans le journal `ORDER_STATUS_FORCED`.
 */
const DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

describeIfDb('Lot 2 — motif d’annulation (PostgreSQL réel)', () => {
  let prisma: PrismaClient;
  const audits: Array<{ action: string; metadata?: unknown }> = [];

  const ADMIN_UID = 'fb-cr-admin';
  const OWNER_UID = 'fb-cr-owner';
  const ORDER = 'cr-order';

  function lifecycle() {
    return new OrderLifecycleService(
      prisma as never,
      new EventEmitter2(),
      new OrderStateMachine(),
      new OrderTransitionService(),
      new StockService(),
      { awardForDeliveredOrder: async () => 0 } as never,
      { rewardForDeliveredOrder: async () => undefined } as never,
      { openForCancelledOrder: async () => null } as never,
      {
        record: async (entry: { action: string; metadata?: unknown }) => {
          audits.push(entry);
        },
      } as never,
      new OutboxService(prisma as never),
      { announce: async () => undefined } as never,
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
    audits.length = 0;
    await prisma.$executeRawUnsafe(`
      TRUNCATE TABLE "OutboxEvent", "OrderItem", "OrderHistory", "Order",
                     "Restaurant", "User", "PlatformSettings"
      RESTART IDENTITY CASCADE
    `);
    await prisma.user.createMany({
      data: [
        {
          id: 'cr-owner',
          firebaseUid: OWNER_UID,
          email: 'cr-o@test.local',
          role: 'RESTAURATEUR',
        },
        {
          id: 'cr-admin',
          firebaseUid: ADMIN_UID,
          email: 'cr-a@test.local',
          role: 'ADMIN',
        },
        {
          id: 'cr-client',
          firebaseUid: 'fb-cr-client',
          email: 'cr-c@test.local',
        },
      ],
    });
    await prisma.restaurant.create({
      data: {
        id: 'cr-vendor',
        nom: 'Chez Motif',
        adresse: 'Moungali',
        phone: '060000080',
        ownerId: 'cr-owner',
      },
    });
  });

  async function createOrder(status: OrderStatus) {
    await prisma.order.create({
      data: {
        id: ORDER,
        restaurantId: 'cr-vendor',
        userId: 'cr-client',
        subTotal: 4000,
        deliveryFee: 0,
        deliveryFeeGross: 0,
        total: 4000,
        paymentMethod: 'MTN_MOMO',
        isDelivery: false,
        status,
      },
    });
  }
  const history = (to: OrderStatus) =>
    prisma.orderHistory.findFirstOrThrow({
      where: { orderId: ORDER, toStatus: to },
    });

  it('ADMIN : le motif entre dans l’historique et dans le journal', async () => {
    await createOrder(OrderStatus.EN_PREPARATION);

    await lifecycle().updateOrderStatusByRestaurateur(
      ORDER,
      ADMIN_UID,
      'ANNULER',
      {
        cancelReason: 'Client injoignable après trois appels',
      },
    );

    expect((await history(OrderStatus.ANNULER)).reason).toContain(
      'Client injoignable après trois appels',
    );
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: 'ORDER_STATUS_FORCED',
      metadata: {
        from: 'EN_PREPARATION',
        to: 'ANNULER',
        reason: 'Client injoignable après trois appels',
      },
    });
  });

  it('vendeur : le motif entre dans l’historique', async () => {
    await createOrder(OrderStatus.EN_PREPARATION);

    await lifecycle().updateOrderStatusByRestaurateur(
      ORDER,
      OWNER_UID,
      'ANNULER',
      {
        cancelReason: 'Plus de gaz',
      },
    );

    expect((await history(OrderStatus.ANNULER)).reason).toContain(
      'Plus de gaz',
    );
  });

  it('sans motif : comportement d’avant (applications installées)', async () => {
    await createOrder(OrderStatus.EN_PREPARATION);

    await lifecycle().updateOrderStatusByRestaurateur(
      ORDER,
      ADMIN_UID,
      'ANNULER',
    );

    expect((await history(OrderStatus.ANNULER)).reason).toBeNull();
    expect(audits[0].metadata).toEqual({
      from: 'EN_PREPARATION',
      to: 'ANNULER',
    });
  });

  it('motif sur une transition qui n’annule pas : ignoré', async () => {
    await createOrder(OrderStatus.EN_PREPARATION);

    await lifecycle().updateOrderStatusByRestaurateur(
      ORDER,
      OWNER_UID,
      'PRET',
      {
        cancelReason: 'Ne devrait rien écrire',
      },
    );

    expect((await history(OrderStatus.PRET)).reason).toBeNull();
  });
});
