import { PrismaPg } from '@prisma/adapter-pg';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { OrderStatus, PrismaClient } from '@prisma/client';

import { OrderLifecycleService } from '../../apps/lilia-app/src/modules/orders/order-lifecycle.service';
import { OrderStateMachine } from '../../apps/lilia-app/src/modules/orders/order-state.machine';
import { OrderTransitionService } from '../../apps/lilia-app/src/modules/orders/order-transition.service';
import { StockService } from '../../apps/lilia-app/src/modules/orders/stock.service';
import { RefundsService } from '../../apps/lilia-app/src/modules/refunds/refunds.service';
import { RefundExecutionService } from '../../apps/lilia-app/src/modules/refunds/refund-execution.service';
import { RestaurantPayoutService } from '../../apps/lilia-app/src/modules/payments/services/restaurant-payout.service';
import { PaymentEventService } from '../../apps/lilia-app/src/modules/payments/services/payment-event.service';
import { OutboxService } from '../../apps/lilia-app/src/modules/outbox/outbox.service';
import { OrderOutboxEffectsService } from '../../apps/lilia-app/src/modules/outbox/order-outbox-effects.service';
import { PayoutStateMachine } from '../../apps/lilia-app/src/modules/payments/payout-state.machine';

/**
 * **F-04 (Master Audit v1) — jamais deux sorties d'argent pour une commande.**
 *
 * Reversement vendeur, remboursement client et annulation décidaient chacun
 * sur la foi d'une lecture faite hors transaction. Ils sont désormais
 * sérialisés par le verrou de la ligne `Order` (`order-row-lock.ts`). Ces
 * tests font réellement courir les services de production, en parallèle,
 * contre PostgreSQL, et vérifient l'invariant — pas l'ordre d'arrivée.
 *
 * Le prestataire est un double qui compte ses appels : c'est le nombre de
 * virements réellement émis qui fait foi.
 */
const DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

describeIfDb(
  'Reversement / remboursement / annulation (PostgreSQL réel)',
  () => {
    let prisma: PrismaClient;
    let payouts: RestaurantPayoutService;
    let lifecycle: OrderLifecycleService;
    let refundExec: RefundExecutionService;
    const providerCalls: string[] = [];

    const ADMIN = 'pr-admin';
    const OWNER = 'pr-owner';
    const CLIENT = 'pr-client';
    const VENDOR = 'pr-vendor';
    const ORDER = 'pr-order';

    const provider = {
      name: 'PAWAPAY',
      supportsPayout: true,
      createPayout: async (input: { payoutId: string }) => {
        providerCalls.push(input.payoutId);
        // Laisse le temps à l'autre geste de se présenter au verrou.
        await new Promise((r) => setTimeout(r, 30));
        return { accepted: true, duplicate: false, raw: {} };
      },
    };

    beforeAll(async () => {
      prisma = new PrismaClient({
        adapter: new PrismaPg({ connectionString: DATABASE_URL }),
      });
      await prisma.$connect();
      const registry = {
        currentMode: 'PAWAPAY',
        forPayout: () => provider,
      };
      const events = new PaymentEventService(prisma as never);
      payouts = new RestaurantPayoutService(
        prisma as never,
        registry as never,
        events,
        new PayoutStateMachine(),
        new EventEmitter2(),
      );
      const refunds = new RefundsService(prisma as never);
      lifecycle = new OrderLifecycleService(
        prisma as never,
        new EventEmitter2(),
        new OrderStateMachine(),
        new OrderTransitionService(),
        new StockService(),
        { awardForDeliveredOrder: async () => 0 } as never,
        { rewardForDeliveredOrder: async () => undefined } as never,
        refunds,
        { record: async () => undefined } as never,
        new OutboxService(prisma as never),
      );
      refundExec = new RefundExecutionService(
        prisma as never,
        registry as never,
        events,
      );
    });

    afterAll(async () => {
      await prisma.$disconnect();
    });

    beforeEach(async () => {
      providerCalls.length = 0;
      await prisma.$executeRawUnsafe(`
      TRUNCATE TABLE "PaymentEvent", "restaurant_payouts", "Incident",
                     "OrderItem", "OrderHistory", "LoyaltyTransaction",
                     "PromoUsage", "payments", "Refund", "OutboxEvent", "Order",
                     "Restaurant", "User"
      RESTART IDENTITY CASCADE
    `);
      await prisma.user.createMany({
        data: [
          {
            id: ADMIN,
            firebaseUid: 'fb-pr-a',
            email: 'pr-a@test.local',
            role: 'ADMIN',
          },
          {
            id: OWNER,
            firebaseUid: 'fb-pr-o',
            email: 'pr-o@test.local',
            role: 'RESTAURATEUR',
          },
          { id: CLIENT, firebaseUid: 'fb-pr-c', email: 'pr-c@test.local' },
        ],
      });
      await prisma.restaurant.create({
        data: {
          id: VENDOR,
          nom: 'Chez Reversement',
          adresse: 'Poto-Poto',
          phone: '060000030',
          ownerId: OWNER,
          payoutPhoneNumber: '242060000030',
          payoutProvider: 'MTN_MOMO',
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
          commissionPercent: 10,
          commissionAmount: 500,
          paymentMethod: 'MTN_MOMO',
          status: OrderStatus.PRET,
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

    it('F-08 — numéro de reversement changé il y a une heure : aucun virement', async () => {
      await prisma.restaurant.update({
        where: { id: VENDOR },
        data: { payoutVerifiedAt: new Date(Date.now() - 3_600_000) },
      });
      await expect(
        payouts.requestPayout({ orderId: ORDER, adminUserId: ADMIN }),
      ).rejects.toThrow(/vient d’être modifié/);
      expect(providerCalls).toHaveLength(0);
      expect(await prisma.restaurantPayout.count()).toBe(0);
    });

    it('scénario 5 — deux admins lancent le même reversement : une ligne, UN virement', async () => {
      const results = await Promise.allSettled([
        payouts.requestPayout({ orderId: ORDER, adminUserId: ADMIN }),
        payouts.requestPayout({ orderId: ORDER, adminUserId: ADMIN }),
        payouts.requestPayout({ orderId: ORDER, adminUserId: ADMIN }),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(await prisma.restaurantPayout.count()).toBe(1);
      expect(providerCalls).toHaveLength(1);
    });

    it('scénario 6 — le vendeur annule pendant que le reversement part : jamais « payé ET annulé »', async () => {
      for (let round = 0; round < 8; round++) {
        if (round > 0) {
          await prisma.restaurantPayout.deleteMany();
          await prisma.refund.deleteMany();
          await prisma.orderHistory.deleteMany();
          await prisma.order.update({
            where: { id: ORDER },
            data: { status: OrderStatus.PRET },
          });
        }
        await Promise.allSettled([
          payouts.requestPayout({ orderId: ORDER, adminUserId: ADMIN }),
          lifecycle.updateOrderStatusByRestaurateur(
            ORDER,
            'fb-pr-o',
            OrderStatus.ANNULER,
          ),
        ]);

        const order = await prisma.order.findUniqueOrThrow({
          where: { id: ORDER },
        });
        const payout = await prisma.restaurantPayout.findUnique({
          where: { orderId: ORDER },
        });
        // L'un OU l'autre, jamais les deux.
        if (payout) {
          expect(order.status).toBe(OrderStatus.PRET);
          expect(await prisma.refund.count()).toBe(0);
        } else {
          expect(order.status).toBe(OrderStatus.ANNULER);
        }
      }
    });

    it('après un reversement, le vendeur ne peut plus annuler (409)', async () => {
      await payouts.requestPayout({ orderId: ORDER, adminUserId: ADMIN });
      await expect(
        lifecycle.updateOrderStatusByRestaurateur(
          ORDER,
          'fb-pr-o',
          OrderStatus.ANNULER,
        ),
      ).rejects.toThrow(/déjà été reversée/);
      const order = await prisma.order.findUniqueOrThrow({
        where: { id: ORDER },
      });
      expect(order.status).toBe(OrderStatus.PRET);
    });

    it('annulation ADMIN pendant un reversement PENDING : le remboursement s’ouvre mais ne part PAS', async () => {
      await payouts.requestPayout({ orderId: ORDER, adminUserId: ADMIN });
      await lifecycle.updateOrderStatusByRestaurateur(
        ORDER,
        'fb-pr-a',
        OrderStatus.ANNULER,
      );
      const refund = await prisma.refund.findUniqueOrThrow({
        where: { orderId: ORDER },
      });
      providerCalls.length = 0;

      await expect(refundExec.execute(refund.id, ADMIN)).rejects.toThrow(
        /reversement au vendeur est en cours/,
      );
      expect(providerCalls).toHaveLength(0);
      expect(
        (await prisma.refund.findUniqueOrThrow({ where: { id: refund.id } }))
          .status,
      ).toBe('PENDING');
    });

    it('reversement confirmé sur une commande annulée entre-temps : incident CRITICAL ouvert', async () => {
      const res = await payouts.requestPayout({
        orderId: ORDER,
        adminUserId: ADMIN,
      });
      await lifecycle.updateOrderStatusByRestaurateur(
        ORDER,
        'fb-pr-a',
        OrderStatus.ANNULER,
      );
      await payouts.applyPayoutProviderStatus({
        payoutId: res.payout.id,
        status: {
          state: 'SUCCESS',
          rawStatus: 'COMPLETED',
          amountXaf: res.payout.amount,
          currency: 'XAF',
          raw: {},
        },
        source: 'WEBHOOK',
      });
      const incidents = await prisma.incident.findMany({
        where: { orderId: ORDER },
      });
      expect(incidents.map((i) => i.title)).toContain(
        'Vendeur payé sur une commande annulée',
      );
    });

    it('remboursement exécuté d’abord : plus aucun reversement possible', async () => {
      await lifecycle.updateOrderStatusByRestaurateur(
        ORDER,
        'fb-pr-a',
        OrderStatus.ANNULER,
      );
      await expect(
        payouts.requestPayout({ orderId: ORDER, adminUserId: ADMIN }),
      ).rejects.toThrow();
      expect(await prisma.restaurantPayout.count()).toBe(0);
    });

    it('lot 4 — processus mort après l’annulation : l’outbox rouvre le remboursement, une seule fois', async () => {
      await lifecycle.updateOrderStatusByRestaurateur(
        ORDER,
        'fb-pr-a',
        OrderStatus.ANNULER,
      );
      const obligation = await prisma.outboxEvent.findFirstOrThrow({
        where: { aggregateId: ORDER, type: 'order.refund_due' },
      });
      // On simule la mort du processus entre le commit et l'appel immédiat :
      // la dette n'existe plus que dans l'outbox.
      await prisma.refund.deleteMany({ where: { orderId: ORDER } });

      const effects = new OrderOutboxEffectsService(
        prisma as never,
        new OutboxService(prisma as never),
        { registerHandler: () => undefined } as never,
        { sendPushNotification: async () => undefined } as never,
        { awardForDeliveredOrder: async () => undefined } as never,
        { rewardForDeliveredOrder: async () => undefined } as never,
        new RefundsService(prisma as never),
      );
      await effects.dispatchRefundDue(obligation);
      await effects.dispatchRefundDue(obligation); // rejeu : sans effet

      const refunds = await prisma.refund.findMany({
        where: { orderId: ORDER },
      });
      expect(refunds).toHaveLength(1);
      expect(refunds[0]).toMatchObject({ amount: 6750, status: 'PENDING' });
      expect(
        (
          await prisma.outboxEvent.findUniqueOrThrow({
            where: { id: obligation.id },
          })
        ).status,
      ).toBe('SENT');
    });
  },
);
