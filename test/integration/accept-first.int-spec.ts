import { PrismaPg } from '@prisma/adapter-pg';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { OrderStatus, PaymentEventSource, PrismaClient } from '@prisma/client';

import { OrderLifecycleService } from '../../apps/lilia-app/src/modules/orders/order-lifecycle.service';
import { OrderStateMachine } from '../../apps/lilia-app/src/modules/orders/order-state.machine';
import { OrderTransitionService } from '../../apps/lilia-app/src/modules/orders/order-transition.service';
import { StockService } from '../../apps/lilia-app/src/modules/orders/stock.service';
import { RefundsService } from '../../apps/lilia-app/src/modules/refunds/refunds.service';
import { PaymentEventService } from '../../apps/lilia-app/src/modules/payments/services/payment-event.service';
import { PaymentService } from '../../apps/lilia-app/src/modules/payments/services/payment.service';
import { OutboxService } from '../../apps/lilia-app/src/modules/outbox/outbox.service';
import { OrderRequestExpiryService } from '../../apps/lilia-app/src/modules/schedule/order-request-expiry.service';

/**
 * Durcissement lot 3 — « accepter puis payer » sur PostgreSQL réel.
 *
 * Les tests obligatoires de la mission :
 *  - refus avant paiement : aucune opération de remboursement ;
 *  - expiration de la demande : aucune préparation ne commence ;
 *  - acceptation concurrente avec l'expiration : une seule issue gagne ;
 *  - paiement tardif : incident et procédure explicite ;
 *  - webhook et interrogation simultanés : une seule confirmation ;
 *  - paiement impossible tant que le vendeur n'a pas accepté.
 * La « réponse maîtrisée » à une ancienne application vendeurs est couverte
 * par `vendor-app-compat.guard.spec.ts`.
 *
 * Aucun prestataire réel : seuls des signaux simulés sont appliqués.
 */
const DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

describeIfDb('Accepter puis payer (PostgreSQL réel)', () => {
  let prisma: PrismaClient;
  let lifecycle: OrderLifecycleService;
  let payments: PaymentService;
  let requestExpiry: OrderRequestExpiryService;

  const OWNER = 'af-owner';
  const OWNER_UID = 'fb-af-o';
  const CLIENT = 'af-client';
  const CLIENT_UID = 'fb-af-c';
  const VENDOR = 'af-vendor';
  const ORDER = 'af-order';
  const TOTAL = 4450;

  beforeAll(async () => {
    prisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: DATABASE_URL }),
    });
    await prisma.$connect();
    const outbox = new OutboxService(prisma as never);
    const transitions = new OrderTransitionService();
    lifecycle = new OrderLifecycleService(
      prisma as never,
      new EventEmitter2(),
      new OrderStateMachine(),
      transitions,
      new StockService(),
      { awardForDeliveredOrder: async () => 0 } as never,
      { rewardForDeliveredOrder: async () => undefined } as never,
      new RefundsService(prisma as never),
      { record: async () => undefined } as never,
      outbox,
      { announce: async () => undefined } as never,
    );
    payments = new PaymentService(
      prisma as never,
      new EventEmitter2(),
      { get: (_k: string, d?: unknown) => d } as never,
      { currentMode: 'PAWAPAY' } as never,
      new PaymentEventService(prisma as never),
      outbox,
      transitions,
    );
    requestExpiry = new OrderRequestExpiryService(prisma as never, lifecycle, {
      runExclusively: (_n: string, _t: number, f: () => unknown) => f(),
    } as never);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(`
      TRUNCATE TABLE "PaymentEvent", "Incident", "OrderItem", "OrderHistory",
                     "LoyaltyTransaction", "PromoUsage", "payments", "Refund",
                     "OutboxEvent", "Order", "Restaurant", "User",
                     "PlatformSettings"
      RESTART IDENTITY CASCADE
    `);
    await prisma.platformSettings.create({
      data: {
        id: 'singleton',
        orderFlow: 'ACCEPT_FIRST',
        // Même allumée, l'acceptation après paiement ne concerne pas ce
        // parcours : aucune échéance ne doit être posée à `PAYER`.
        orderAcceptanceRequired: true,
      },
    });
    await prisma.user.createMany({
      data: [
        {
          id: OWNER,
          firebaseUid: OWNER_UID,
          email: 'af-o@test.local',
          role: 'RESTAURATEUR',
        },
        { id: CLIENT, firebaseUid: CLIENT_UID, email: 'af-c@test.local' },
      ],
    });
    await prisma.restaurant.create({
      data: {
        id: VENDOR,
        nom: 'Chez Demande',
        adresse: 'Moungali',
        phone: '060000077',
        ownerId: OWNER,
      },
    });
  });

  async function request(expiresInMs = 5 * 60_000) {
    await prisma.order.create({
      data: {
        id: ORDER,
        restaurantId: VENDOR,
        userId: CLIENT,
        subTotal: 3000,
        deliveryFee: 1000,
        serviceFee: 450,
        total: TOTAL,
        paymentMethod: 'MTN_MOMO',
        status: OrderStatus.DEMANDE_ENVOYEE,
        orderFlow: 'ACCEPT_FIRST',
        requestExpiresAt: new Date(Date.now() + expiresInMs),
      },
    });
  }

  const order = () => prisma.order.findUniqueOrThrow({ where: { id: ORDER } });
  const refundObligations = () =>
    prisma.outboxEvent.count({ where: { type: 'order.refund_due' } });
  const pendingPayment = (id = 'af-pay') =>
    prisma.payment.create({
      data: {
        id,
        orderId: ORDER,
        amount: TOTAL,
        phoneNumber: '242060000099',
        status: 'PENDING',
        provider: 'PAWAPAY',
        providerTransactionId: `dep-${id}`,
        method: 'MTN_MOMO',
      },
    });
  const success = (paymentId: string, source: PaymentEventSource) =>
    payments.applyCollectionProviderStatus({
      paymentId,
      status: {
        state: 'SUCCESS',
        rawStatus: 'COMPLETED',
        amountXaf: TOTAL,
        currency: 'XAF',
        providerTransactionId: `pawa-${paymentId}`,
        raw: { status: 'COMPLETED' },
      },
      source,
    });

  it('la base refuse une demande hors du parcours ACCEPT_FIRST', async () => {
    await expect(
      prisma.order.create({
        data: {
          id: 'af-bad',
          restaurantId: VENDOR,
          userId: CLIENT,
          subTotal: 1,
          deliveryFee: 0,
          serviceFee: 0,
          total: 1,
          paymentMethod: 'MTN_MOMO',
          status: OrderStatus.DEMANDE_ENVOYEE,
        },
      }),
    ).rejects.toThrow(/Order_request_needs_accept_first/);
  });

  it('accepter ouvre le paiement : EN_ATTENTE, échéance, « payez maintenant » durable', async () => {
    await request();
    await lifecycle.acceptOrder(ORDER, OWNER_UID, 20);

    const o = await order();
    expect(o.status).toBe(OrderStatus.EN_ATTENTE);
    expect(o.acceptedAt).not.toBeNull();
    expect(o.paymentDueAt!.getTime() - o.acceptedAt!.getTime()).toBe(
      10 * 60_000,
    );
    expect(
      await prisma.outboxEvent.count({
        where: { type: 'order.request_accepted', aggregateId: ORDER },
      }),
    ).toBe(1);
    const history = await prisma.orderHistory.findMany({
      where: { orderId: ORDER },
    });
    expect(history.map((h) => `${h.fromStatus}→${h.toStatus}`)).toEqual([
      'DEMANDE_ENVOYEE→EN_ATTENTE',
    ]);
  });

  it('aucun paiement tant que le vendeur n’a pas accepté (aucune demande prestataire)', async () => {
    await request();
    await expect(
      payments.createPayment(
        { orderId: ORDER, phoneNumber: '242060000099' } as never,
        CLIENT_UID,
        'provider',
      ),
    ).rejects.toMatchObject({
      response: { code: 'ORDER_AWAITING_VENDOR' },
    });
    expect(await prisma.payment.count()).toBe(0);
  });

  it('refus avant paiement : annulée, aucun remboursement ni obligation', async () => {
    await request();
    await lifecycle.rejectOrder(ORDER, OWNER_UID, { reason: 'TOO_BUSY' });

    expect((await order()).status).toBe(OrderStatus.ANNULER);
    expect(await prisma.refund.count()).toBe(0);
    expect(await refundObligations()).toBe(0);
  });

  it('le client renonce à sa demande : annulée, aucun remboursement', async () => {
    await request();
    await lifecycle.cancelOrder(ORDER, CLIENT_UID);

    expect((await order()).status).toBe(OrderStatus.ANNULER);
    expect(await prisma.refund.count()).toBe(0);
  });

  it('expiration de la demande : annulée par le cron, rien encaissé, aucune préparation', async () => {
    await request(-1_000);
    expect(await requestExpiry.runUnlocked()).toBe(1);

    const o = await order();
    expect(o.status).toBe(OrderStatus.ANNULER);
    expect(o.acceptedAt).toBeNull();
    expect(await prisma.refund.count()).toBe(0);
    expect(await refundObligations()).toBe(0);
    expect(
      await prisma.outboxEvent.count({
        where: { type: 'order.request_expired' },
      }),
    ).toBe(1);
    // Rejouer le passage n'écrit rien de plus.
    expect(await requestExpiry.runUnlocked()).toBe(0);
  });

  it('accepter après l’échéance est refusé, même avant le passage du cron', async () => {
    await request(-1_000);
    await expect(
      lifecycle.acceptOrder(ORDER, OWNER_UID, 20),
    ).rejects.toMatchObject({ response: { code: 'ORDER_REQUEST_EXPIRED' } });
    expect((await order()).status).toBe(OrderStatus.DEMANDE_ENVOYEE);
  });

  it('acceptation et expiration simultanées : une seule issue, jamais les deux', async () => {
    for (let round = 0; round < 15; round++) {
      await prisma.$executeRawUnsafe(
        `TRUNCATE TABLE "OrderHistory", "OutboxEvent", "Order" RESTART IDENTITY CASCADE`,
      );
      // Échéance dans 2 s : l'acceptation passe sa vérification, et le cron
      // joue « dans 10 s » — les deux atteignent le verrou.
      await request(2_000);
      const [accepted, expired] = await Promise.allSettled([
        lifecycle.acceptOrder(ORDER, OWNER_UID, 20),
        lifecycle.expireRequest(ORDER, new Date(Date.now() + 10_000)),
      ]);

      const o = await order();
      const transitions = await prisma.orderHistory.count({
        where: { orderId: ORDER, fromStatus: 'DEMANDE_ENVOYEE' },
      });
      expect(transitions).toBe(1);
      if (o.status === OrderStatus.EN_ATTENTE) {
        expect(accepted.status).toBe('fulfilled');
        expect(expired).toEqual({ status: 'fulfilled', value: false });
      } else {
        expect(o.status).toBe(OrderStatus.ANNULER);
        expect(accepted.status).toBe('rejected');
        expect(expired).toEqual({ status: 'fulfilled', value: true });
      }
    }
  });

  it('payée après acceptation : PAYER une seule fois, sans échéance d’acceptation, webhook + sondage simultanés', async () => {
    await request();
    await lifecycle.acceptOrder(ORDER, OWNER_UID, 20);
    await pendingPayment();

    const outcomes = await Promise.all([
      success('af-pay', PaymentEventSource.WEBHOOK),
      success('af-pay', PaymentEventSource.CLIENT_POLL),
    ]);
    expect([...outcomes].sort()).toEqual(['APPLIED', 'DUPLICATE']);

    const o = await order();
    expect(o.status).toBe(OrderStatus.PAYER);
    // Acceptée avant d'être payée : aucune échéance qui l'annulerait.
    expect(o.acceptDeadlineAt).toBeNull();
    expect(
      await prisma.orderHistory.count({
        where: { orderId: ORDER, toStatus: 'PAYER' },
      }),
    ).toBe(1);
    expect(
      await prisma.outboxEvent.count({ where: { type: 'order.paid' } }),
    ).toBe(1);
  });

  it('payée et acceptée : « préparer » directement, « accepter » refusé', async () => {
    await request();
    await lifecycle.acceptOrder(ORDER, OWNER_UID, 20);
    await pendingPayment();
    await success('af-pay', PaymentEventSource.WEBHOOK);

    await expect(
      lifecycle.acceptOrder(ORDER, OWNER_UID, 20),
    ).rejects.toMatchObject({ response: { code: 'ORDER_ALREADY_ACCEPTED' } });

    const acceptedAt = (await order()).acceptedAt;
    await lifecycle.updateOrderStatusByRestaurateur(
      ORDER,
      OWNER_UID,
      'EN_PREPARATION',
    );
    const o = await order();
    expect(o.status).toBe(OrderStatus.EN_PREPARATION);
    expect(o.acceptedAt).toEqual(acceptedAt);
  });

  it('fenêtre de paiement close : paiement refusé avant tout appel prestataire', async () => {
    await request();
    await lifecycle.acceptOrder(ORDER, OWNER_UID, 20);
    await prisma.order.update({
      where: { id: ORDER },
      data: { paymentDueAt: new Date(Date.now() - 1_000) },
    });
    await expect(
      payments.createPayment(
        { orderId: ORDER, phoneNumber: '242060000099' } as never,
        CLIENT_UID,
        'provider',
      ),
    ).rejects.toMatchObject({ response: { code: 'PAYMENT_WINDOW_CLOSED' } });
    expect(await prisma.payment.count()).toBe(0);
  });

  it('paiement tardif (confirmé après l’annulation) : incident CRITIQUE avec la procédure', async () => {
    await request();
    await lifecycle.acceptOrder(ORDER, OWNER_UID, 20);
    await pendingPayment();
    // La commande expire faute de paiement : le `Payment` PENDING est clos.
    expect(await lifecycle.expireUnpaidOrder(ORDER)).toBe(true);

    const outcome = await success('af-pay', PaymentEventSource.WEBHOOK);
    expect(outcome).toBe('MISMATCH');

    expect((await order()).status).toBe(OrderStatus.ANNULER);
    const incident = await prisma.incident.findFirstOrThrow({
      where: { orderId: ORDER },
    });
    expect(incident.severity).toBe('CRITICAL');
    expect(incident.description).toMatch(/ouvrir un remboursement/);
  });
});
