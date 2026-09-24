import { PrismaPg } from '@prisma/adapter-pg';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { OrderStatus, PrismaClient } from '@prisma/client';

import { OrderLifecycleService } from '../../apps/lilia-app/src/modules/orders/order-lifecycle.service';
import { OrderStateMachine } from '../../apps/lilia-app/src/modules/orders/order-state.machine';
import { OrderTransitionService } from '../../apps/lilia-app/src/modules/orders/order-transition.service';
import { StockService } from '../../apps/lilia-app/src/modules/orders/stock.service';
import { RefundsService } from '../../apps/lilia-app/src/modules/refunds/refunds.service';
import { RefundExecutionService } from '../../apps/lilia-app/src/modules/refunds/refund-execution.service';
import { PaymentEventService } from '../../apps/lilia-app/src/modules/payments/services/payment-event.service';
import { OutboxService } from '../../apps/lilia-app/src/modules/outbox/outbox.service';
import { OrderOutboxEffectsService } from '../../apps/lilia-app/src/modules/outbox/order-outbox-effects.service';

/**
 * **F3-01 — aucun client débité n'attend une réponse qui ne viendra jamais.**
 *
 * Trois garanties que seul un vrai PostgreSQL peut établir :
 *  1. l'échéance est posée dans le même `UPDATE` que le passage à `PAYER` ;
 *  2. une acceptation et une expiration simultanées ne produisent jamais
 *     « acceptée ET remboursée » — le verrou `WHERE status = PAYER` départage ;
 *  3. la chaîne expiration → outbox → remboursement émet UN virement, même
 *     quand l'obligation est rejouée.
 *
 * Le prestataire est un double qui compte ses appels : c'est le nombre de
 * virements réellement émis qui fait foi.
 */
const DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

describeIfDb('Acceptation vendeur (PostgreSQL réel)', () => {
  let prisma: PrismaClient;
  let lifecycle: OrderLifecycleService;
  let effects: OrderOutboxEffectsService;
  const transitions = new OrderTransitionService();
  const providerCalls: string[] = [];

  const OWNER = 'acc-owner';
  const CLIENT = 'acc-client';
  const VENDOR = 'acc-vendor';
  const ORDER = 'acc-order';
  const PAST_DEADLINE = () => new Date(Date.now() - 60_000);

  const provider = {
    name: 'PAWAPAY',
    supportsPayout: true,
    createPayout: async (input: { payoutId: string }) => {
      providerCalls.push(input.payoutId);
      return { accepted: true, duplicate: false, raw: {} };
    },
  };

  beforeAll(async () => {
    prisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: DATABASE_URL }),
    });
    await prisma.$connect();
    const registry = { currentMode: 'PAWAPAY', forPayout: () => provider };
    const events = new PaymentEventService(prisma as never);
    const refunds = new RefundsService(prisma as never);
    const outbox = new OutboxService(prisma as never);
    lifecycle = new OrderLifecycleService(
      prisma as never,
      new EventEmitter2(),
      new OrderStateMachine(),
      transitions,
      new StockService(),
      { awardForDeliveredOrder: async () => 0 } as never,
      { rewardForDeliveredOrder: async () => undefined } as never,
      refunds,
      { record: async () => undefined } as never,
      outbox,
    );
    effects = new OrderOutboxEffectsService(
      prisma as never,
      outbox,
      { registerHandler: () => undefined } as never,
      { sendPushNotification: async () => undefined } as never,
      {} as never,
      {} as never,
      refunds,
      new RefundExecutionService(prisma as never, registry as never, events),
    );
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function resetOrder(
    status: OrderStatus,
    acceptDeadlineAt: Date | null,
  ) {
    await prisma.$executeRawUnsafe(
      `TRUNCATE TABLE "PaymentEvent", "OutboxEvent", "Refund", "OrderHistory",
                      "LoyaltyTransaction", "PromoUsage" RESTART IDENTITY CASCADE`,
    );
    await prisma.order.update({
      where: { id: ORDER },
      data: {
        status,
        acceptDeadlineAt,
        acceptedAt: null,
        estimatedReadyAt: null,
      },
    });
  }

  beforeEach(async () => {
    providerCalls.length = 0;
    await prisma.$executeRawUnsafe(`
      TRUNCATE TABLE "PaymentEvent", "restaurant_payouts", "Incident",
                     "OrderItem", "OrderHistory", "LoyaltyTransaction",
                     "PromoUsage", "payments", "Refund", "OutboxEvent", "Order",
                     "Restaurant", "User", "PlatformSettings"
      RESTART IDENTITY CASCADE
    `);
    await prisma.platformSettings.create({
      data: { id: 'singleton', orderAcceptanceRequired: true },
    });
    await prisma.user.createMany({
      data: [
        {
          id: OWNER,
          firebaseUid: 'fb-acc-o',
          email: 'acc-o@test.local',
          role: 'RESTAURATEUR',
        },
        { id: CLIENT, firebaseUid: 'fb-acc-c', email: 'acc-c@test.local' },
      ],
    });
    await prisma.restaurant.create({
      data: {
        id: VENDOR,
        nom: 'Chez Acceptation',
        adresse: 'Bacongo',
        phone: '060000040',
        ownerId: OWNER,
      },
    });
    await prisma.order.create({
      data: {
        id: ORDER,
        restaurantId: VENDOR,
        userId: CLIENT,
        subTotal: 5000,
        deliveryFee: 1000,
        serviceFee: 750,
        total: 6750,
        paymentMethod: 'MTN_MOMO',
        status: OrderStatus.EN_ATTENTE,
      },
    });
    await prisma.payment.create({
      data: {
        orderId: ORDER,
        amount: 6750,
        phoneNumber: '242060000099',
        status: 'SUCCESS',
        provider: 'PAWAPAY',
        method: 'MTN_MOMO',
      },
    });
  });

  it('1 — l’échéance est écrite avec le passage à PAYER (paiement + 8 min)', async () => {
    const paidAt = new Date();
    await prisma.$transaction((tx) =>
      transitions.tryTransition(tx, {
        orderId: ORDER,
        from: OrderStatus.EN_ATTENTE,
        to: OrderStatus.PAYER,
        actor: 'SYSTEM',
        source: 'WEBHOOK',
        data: { paidAt },
      }),
    );

    const order = await prisma.order.findUniqueOrThrow({
      where: { id: ORDER },
    });
    expect(order.status).toBe(OrderStatus.PAYER);
    expect(order.acceptDeadlineAt?.getTime()).toBe(
      paidAt.getTime() + 8 * 60_000,
    );
  });

  it('2 — acceptation et expiration simultanées : un seul gagnant, jamais « acceptée ET remboursée »', async () => {
    for (let round = 0; round < 20; round++) {
      await resetOrder(OrderStatus.PAYER, PAST_DEADLINE());

      await Promise.allSettled([
        lifecycle.acceptOrder(ORDER, 'fb-acc-o', 20),
        lifecycle.expireUnacceptedOrder(ORDER),
      ]);

      const order = await prisma.order.findUniqueOrThrow({
        where: { id: ORDER },
      });
      const refundDue = await prisma.outboxEvent.count({
        where: { aggregateId: ORDER, type: 'order.refund_due' },
      });
      const movesFromPaid = await prisma.orderHistory.count({
        where: { orderId: ORDER, fromStatus: OrderStatus.PAYER },
      });

      expect([OrderStatus.ACCEPTEE, OrderStatus.ANNULER]).toContain(
        order.status,
      );
      expect(movesFromPaid).toBe(1);
      expect(refundDue).toBe(order.status === OrderStatus.ANNULER ? 1 : 0);
    }
  });

  it('3 — expiration → outbox → UN virement de remboursement, même rejouée', async () => {
    await resetOrder(OrderStatus.PAYER, PAST_DEADLINE());

    await expect(lifecycle.expireUnacceptedOrder(ORDER)).resolves.toBe(true);
    const obligation = await prisma.outboxEvent.findFirstOrThrow({
      where: { aggregateId: ORDER, type: 'order.refund_due' },
    });

    await effects.dispatchRefundDue(obligation);
    await effects.dispatchRefundDue(obligation); // rejeu (worker redémarré)

    const refund = await prisma.refund.findFirstOrThrow({
      where: { orderId: ORDER },
    });
    expect(refund.amount).toBe(6750);
    expect(refund.reasonCode).toBe('VENDOR_TIMEOUT');
    // F3-06 — le rejeu n'ouvre pas de second remboursement (index « auto »).
    expect(await prisma.refund.count({ where: { orderId: ORDER } })).toBe(1);
    expect(refund.status).toBe('PROCESSING');
    expect(refund.processedBy).toBeNull(); // le système, pas un administrateur
    expect(providerCalls).toHaveLength(1);
  });

  it('3 bis — réglage D2 désactivé : la dette reste PENDING, aucun virement', async () => {
    await prisma.platformSettings.update({
      where: { id: 'singleton' },
      data: { autoRefundVendorFault: false },
    });
    await resetOrder(OrderStatus.PAYER, PAST_DEADLINE());

    await lifecycle.expireUnacceptedOrder(ORDER);
    const obligation = await prisma.outboxEvent.findFirstOrThrow({
      where: { aggregateId: ORDER, type: 'order.refund_due' },
    });
    await effects.dispatchRefundDue(obligation);

    const refund = await prisma.refund.findFirstOrThrow({
      where: { orderId: ORDER },
    });
    expect(refund.status).toBe('PENDING');
    expect(providerCalls).toHaveLength(0);
  });
});
