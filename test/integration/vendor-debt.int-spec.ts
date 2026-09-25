import { PrismaPg } from '@prisma/adapter-pg';
import { OrderStatus, PrismaClient } from '@prisma/client';

import { OutboxService } from '../../apps/lilia-app/src/modules/outbox/outbox.service';
import { PayoutOutboxEffectsService } from '../../apps/lilia-app/src/modules/outbox/payout-outbox-effects.service';
import { PaymentEventService } from '../../apps/lilia-app/src/modules/payments/services/payment-event.service';
import { RestaurantPayoutService } from '../../apps/lilia-app/src/modules/payments/services/restaurant-payout.service';
import { PayoutStateMachine } from '../../apps/lilia-app/src/modules/payments/payout-state.machine';
import { RefundExecutionService } from '../../apps/lilia-app/src/modules/refunds/refund-execution.service';
import { RefundProviderService } from '../../apps/lilia-app/src/modules/refunds/refund-provider.service';
import { RefundsService } from '../../apps/lilia-app/src/modules/refunds/refunds.service';
import { VendorPayoutAutoService } from '../../apps/lilia-app/src/modules/schedule/vendor-payout-auto.service';
import { vendorDebtXaf } from '../../apps/lilia-app/src/modules/payments/vendor-balance';
import { VendorEarningsService } from '../../apps/lilia-app/src/modules/payments/services/vendor-earnings.service';

/**
 * **F3-07 — dette vendeur et versement automatique (PostgreSQL réel).**
 *
 * Versement 1 h après la remise, réclamation jusqu'à 24 h (D4/D5/D6) : un
 * remboursement à la charge du vendeur arrive souvent APRÈS son versement.
 * Il devient une dette, retenue sur le versement suivant. Les garanties
 * centrales sont des garanties de base : unicité du clawback par
 * remboursement, retenue sous verrou du vendeur, CHECK des signes et du
 * versement à 0.
 */
const DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

describeIfDb('Dette vendeur et versement automatique (PostgreSQL réel)', () => {
  let prisma: PrismaClient;
  let payouts: RestaurantPayoutService;
  let refunds: RefundsService;
  let refundExec: RefundExecutionService;
  let refundProvider: RefundProviderService;
  let auto: VendorPayoutAutoService;
  const sent: { payoutId: string; amountXaf: number }[] = [];
  let reject = false;

  const ADMIN = 'vd-admin';
  const OWNER = 'vd-owner';
  const CLIENT = 'vd-client';
  const VENDOR = 'vd-vendor';

  const provider = {
    name: 'PAWAPAY',
    supportsPayout: true,
    createPayout: async (input: { payoutId: string; amountXaf: number }) => {
      sent.push({ payoutId: input.payoutId, amountXaf: input.amountXaf });
      await new Promise((r) => setTimeout(r, 20));
      return reject
        ? {
            accepted: false,
            failureCode: 'PAYER_LIMIT_REACHED',
            failureMessage: 'Plafond atteint',
            raw: {},
          }
        : { accepted: true, duplicate: false, raw: {} };
    },
  };

  beforeAll(async () => {
    prisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: DATABASE_URL }),
    });
    await prisma.$connect();
    const registry = { currentMode: 'PAWAPAY', forPayout: () => provider };
    const events = new PaymentEventService(prisma as never);
    payouts = new RestaurantPayoutService(
      prisma as never,
      registry as never,
      events,
      new PayoutStateMachine(),
      new OutboxService(prisma as never),
    );
    refunds = new RefundsService(prisma as never);
    refundExec = new RefundExecutionService(
      prisma as never,
      registry as never,
      events,
    );
    refundProvider = new RefundProviderService(prisma as never, events);
    auto = new VendorPayoutAutoService(
      prisma as never,
      payouts,
      registry as never,
      {
        runExclusively: async (_n: string, _t: number, fn: () => unknown) =>
          fn(),
      } as never,
    );
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    sent.length = 0;
    reject = false;
    await prisma.$executeRawUnsafe(`
      TRUNCATE TABLE "VendorBalanceEntry", "PaymentEvent", "restaurant_payouts",
                     "Incident", "OrderItem", "OrderHistory", "payments",
                     "Refund", "OutboxEvent", "Order", "Restaurant", "User",
                     "PlatformSettings"
      RESTART IDENTITY CASCADE
    `);
    await prisma.user.createMany({
      data: [
        {
          id: ADMIN,
          firebaseUid: 'fb-vd-a',
          email: 'vd-a@test.local',
          role: 'ADMIN',
        },
        {
          id: OWNER,
          firebaseUid: 'fb-vd-o',
          email: 'vd-o@test.local',
          role: 'RESTAURATEUR',
        },
        { id: CLIENT, firebaseUid: 'fb-vd-c', email: 'vd-c@test.local' },
      ],
    });
    await prisma.restaurant.create({
      data: {
        id: VENDOR,
        nom: 'Chez Dette',
        adresse: 'Bacongo',
        phone: '060000070',
        ownerId: OWNER,
        payoutPhoneNumber: '242060000070',
        payoutProvider: 'MTN_MOMO',
      },
    });
  });

  /**
   * Commande livrée et encaissée : 5 000 de produits, 10 % de commission ⇒
   * 4 500 dus au vendeur. `payoutDueAt` optionnel (preuve fiable, F3-07).
   */
  async function deliveredOrder(id: string, payoutDueAt?: Date) {
    await prisma.order.create({
      data: {
        id,
        restaurantId: VENDOR,
        userId: CLIENT,
        subTotal: 5000,
        deliveryFee: 0,
        deliveryFeeGross: 0,
        serviceFee: 0,
        total: 5000,
        commissionPercent: 10,
        commissionAmount: 500,
        paymentMethod: 'MTN_MOMO',
        isDelivery: false,
        status: OrderStatus.LIVRER,
        ...(payoutDueAt
          ? {
              deliveredAt: new Date(payoutDueAt.getTime() - 3_600_000),
              deliveryProof: 'PICKUP_CODE',
              payoutDueAt,
            }
          : {}),
      },
    });
    await prisma.payment.create({
      data: {
        orderId: id,
        amount: 5000,
        phoneNumber: '242060000099',
        status: 'SUCCESS',
        provider: 'PAWAPAY',
        method: 'MTN_MOMO',
      },
    });
  }

  /** Versement abouti chez le prestataire. */
  async function paid(orderId: string) {
    const res = await payouts.requestPayout({ orderId, adminUserId: ADMIN });
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
    return res.payout.id;
  }

  /** Réclamation après versement : article manquant, à la charge du vendeur. */
  async function vendorRefund(orderId: string, amount: number) {
    const payment = await prisma.payment.findFirstOrThrow({
      where: { orderId },
    });
    return prisma.refund.create({
      data: {
        orderId,
        paymentId: payment.id,
        amount,
        reason: 'Article manquant',
        reasonCode: 'MISSING_ITEM',
        bearer: 'VENDOR',
      },
    });
  }

  const debt = () => vendorDebtXaf(prisma as never, VENDOR);

  // ─── Naissance de la dette ─────────────────────────────────────────────────

  it('R-06.5 — remboursement vendeur après versement : exécuté, et la dette naît à l’aboutissement', async () => {
    await deliveredOrder('vd-a');
    await paid('vd-a');
    const refund = await vendorRefund('vd-a', 1500);

    // Autrefois refusé (« vendeur déjà reversé ») : c'est désormais le cas normal.
    await refundExec.execute(refund.id, ADMIN);
    expect(await debt()).toBe(0); // le virement client n'a pas encore abouti

    const processing = await prisma.refund.findUniqueOrThrow({
      where: { id: refund.id },
    });
    const apply = () =>
      refundProvider.applyProviderStatus({
        refundId: refund.id,
        status: {
          state: 'SUCCESS',
          rawStatus: 'COMPLETED',
          amountXaf: 1500,
          currency: 'XAF',
          raw: { refundId: processing.providerRefundId },
        },
        source: 'WEBHOOK',
      });
    await apply();
    await apply(); // rejeu du webhook : une seule dette
    expect(await debt()).toBe(1500);
    expect(await prisma.vendorBalanceEntry.count()).toBe(1);
  });

  it('clôture manuelle d’un remboursement vendeur après versement : même dette', async () => {
    await deliveredOrder('vd-a');
    await paid('vd-a');
    const refund = await vendorRefund('vd-a', 1200);
    await refunds.updateStatus(refund.id, 'COMPLETED', ADMIN);
    expect(await debt()).toBe(1200);
  });

  it('remboursement AVANT versement : retenu sur la commande même, pas de dette', async () => {
    await deliveredOrder('vd-a');
    const refund = await vendorRefund('vd-a', 1000);
    await refunds.updateStatus(refund.id, 'COMPLETED', ADMIN);
    expect(await debt()).toBe(0);
    const res = await payouts.requestPayout({
      orderId: 'vd-a',
      adminUserId: ADMIN,
    });
    expect(res.payout.amount).toBe(3500);
  });

  it('un geste de la plateforme ne crée jamais de dette vendeur', async () => {
    await deliveredOrder('vd-a');
    await paid('vd-a');
    const payment = await prisma.payment.findFirstOrThrow({
      where: { orderId: 'vd-a' },
    });
    const refund = await prisma.refund.create({
      data: {
        orderId: 'vd-a',
        paymentId: payment.id,
        amount: 800,
        reason: 'Geste commercial',
        reasonCode: 'GOODWILL',
        bearer: 'PLATFORM',
      },
    });
    await refunds.updateStatus(refund.id, 'COMPLETED', ADMIN);
    expect(await debt()).toBe(0);
  });

  // ─── Retenue sur le versement suivant ──────────────────────────────────────

  it('la dette est retenue sur le versement suivant, qui part NET', async () => {
    await deliveredOrder('vd-a');
    await paid('vd-a');
    await refunds.updateStatus(
      (await vendorRefund('vd-a', 1500)).id,
      'COMPLETED',
      ADMIN,
    );
    await deliveredOrder('vd-b');
    sent.length = 0;

    const res = await payouts.requestPayout({
      orderId: 'vd-b',
      adminUserId: ADMIN,
    });

    expect(res.payout.amount).toBe(3000);
    expect(res.payout.debtDeductionAmount).toBe(1500);
    expect(sent).toEqual([{ payoutId: res.payout.id, amountXaf: 3000 }]);
    expect(await debt()).toBe(0);
  });

  it('versement refusé par le prestataire : la retenue est rendue, le vendeur prévenu par l’outbox', async () => {
    await deliveredOrder('vd-a');
    await paid('vd-a');
    await refunds.updateStatus(
      (await vendorRefund('vd-a', 1500)).id,
      'COMPLETED',
      ADMIN,
    );
    await deliveredOrder('vd-b');
    reject = true;

    const res = await payouts.requestPayout({
      orderId: 'vd-b',
      adminUserId: ADMIN,
    });

    expect(res.status).toBe('FAILED');
    expect(await debt()).toBe(1500);
    expect(
      await prisma.outboxEvent.count({
        where: { type: 'payout.failed', aggregateId: res.payout.id },
      }),
    ).toBe(1);
  });

  it('échec annoncé par le webhook après émission : retenue rendue une seule fois', async () => {
    await deliveredOrder('vd-a');
    await paid('vd-a');
    await refunds.updateStatus(
      (await vendorRefund('vd-a', 1500)).id,
      'COMPLETED',
      ADMIN,
    );
    await deliveredOrder('vd-b');
    const res = await payouts.requestPayout({
      orderId: 'vd-b',
      adminUserId: ADMIN,
    });
    expect(await debt()).toBe(0);

    const failed = {
      payoutId: res.payout.id,
      status: {
        state: 'FAILED' as const,
        rawStatus: 'FAILED',
        failureCode: 'X',
        raw: {},
      },
      source: 'WEBHOOK' as const,
    };
    await payouts.applyPayoutProviderStatus(failed);
    await payouts.applyPayoutProviderStatus(failed);
    expect(await debt()).toBe(1500);

    // La relance repart avec la dette intacte : retenue une seule fois.
    await payouts.retryPayout({ orderId: 'vd-b', adminUserId: ADMIN });
    expect(await debt()).toBe(0);
  });

  it('NETTING — dette supérieure au dû : versement à 0, aucun virement, le reste reporté', async () => {
    await deliveredOrder('vd-a');
    await paid('vd-a');
    await refunds.updateStatus(
      (await vendorRefund('vd-a', 4500)).id,
      'COMPLETED',
      ADMIN,
    );
    await deliveredOrder('vd-b');
    await paid('vd-b'); // 4 500 − 4 500 : NETTING, déjà SUCCESS
    const b = await prisma.restaurantPayout.findUniqueOrThrow({
      where: { orderId: 'vd-b' },
    });
    expect(b).toMatchObject({
      amount: 0,
      provider: 'NETTING',
      status: 'SUCCESS',
      debtDeductionAmount: 4500,
    });
    expect(sent.filter((s) => s.payoutId === b.id)).toHaveLength(0);
    expect(
      await prisma.outboxEvent.count({
        where: { type: 'payout.succeeded', aggregateId: b.id },
      }),
    ).toBe(1);

    await refunds.updateStatus(
      (await vendorRefund('vd-b', 700)).id,
      'COMPLETED',
      ADMIN,
    );
    expect(await debt()).toBe(700);
  });

  it('deux versements simultanés du même vendeur ne retiennent pas deux fois la même dette', async () => {
    await deliveredOrder('vd-a');
    await paid('vd-a');
    await refunds.updateStatus(
      (await vendorRefund('vd-a', 1500)).id,
      'COMPLETED',
      ADMIN,
    );
    await deliveredOrder('vd-b');
    await deliveredOrder('vd-c');

    await Promise.all([
      payouts.requestPayout({ orderId: 'vd-b', adminUserId: ADMIN }),
      payouts.requestPayout({ orderId: 'vd-c', adminUserId: ADMIN }),
    ]);

    const rows = await prisma.restaurantPayout.findMany({
      where: { orderId: { in: ['vd-b', 'vd-c'] } },
    });
    expect(rows.reduce((s, r) => s + r.debtDeductionAmount, 0)).toBe(1500);
    expect(await debt()).toBe(0);
  });

  // ─── Versement automatique ─────────────────────────────────────────────────

  describe('versement automatique (worker)', () => {
    const past = () => new Date(Date.now() - 60_000);
    const future = () => new Date(Date.now() + 3_600_000);

    it('éteint par défaut : rien ne part', async () => {
      await deliveredOrder('vd-a', past());
      expect(await auto.runUnlocked()).toBe(0);
      expect(sent).toHaveLength(0);
    });

    it('allumé : seules les commandes ÉCHUES à preuve fiable partent, une fois', async () => {
      await prisma.platformSettings.create({
        data: { id: 'singleton', vendorPayoutAutoEnabled: true },
      });
      await deliveredOrder('vd-due', past());
      await deliveredOrder('vd-later', future());
      await deliveredOrder('vd-noproof'); // remise déclarée seule : pas d'échéance

      expect(await auto.runUnlocked()).toBe(1);
      expect(await auto.runUnlocked()).toBe(0); // déjà versée : pas deux fois

      const rows = await prisma.restaurantPayout.findMany();
      expect(rows.map((r) => r.orderId)).toEqual(['vd-due']);
      expect(rows[0].requestedBy).toBeNull();
      expect(rows[0].metadata).toMatchObject({ trigger: 'AUTO' });
    });

    it('un versement automatique en échec n’est pas relancé seul', async () => {
      await prisma.platformSettings.create({
        data: { id: 'singleton', vendorPayoutAutoEnabled: true },
      });
      await deliveredOrder('vd-due', past());
      reject = true;
      await auto.runUnlocked();
      reject = false;
      expect(await auto.runUnlocked()).toBe(0);
      expect(sent).toHaveLength(1);
    });

    it('compte en carence (numéro changé il y a 1 h) : différé, pas d’erreur', async () => {
      await prisma.platformSettings.create({
        data: { id: 'singleton', vendorPayoutAutoEnabled: true },
      });
      await prisma.restaurant.update({
        where: { id: VENDOR },
        data: { payoutVerifiedAt: new Date(Date.now() - 3_600_000) },
      });
      await deliveredOrder('vd-due', past());
      expect(await auto.runUnlocked()).toBe(0);
      expect(await prisma.restaurantPayout.count()).toBe(0);
    });
  });

  it('« Mes gains » : à venir, en attente de preuve, reçu, dette — pour SES boutiques seulement', async () => {
    await deliveredOrder('vd-a');
    await paid('vd-a');
    await refunds.updateStatus(
      (await vendorRefund('vd-a', 1500)).id,
      'COMPLETED',
      ADMIN,
    );
    await deliveredOrder('vd-due', new Date(Date.now() + 3_600_000));
    await deliveredOrder('vd-noproof');
    // Une boutique d'un autre vendeur ne doit rien faire apparaître.
    await prisma.user.create({
      data: {
        id: 'vd-other',
        firebaseUid: 'fb-vd-x',
        email: 'vd-x@test.local',
        role: 'RESTAURATEUR',
      },
    });

    const earnings = new VendorEarningsService(prisma as never);
    const { data, meta } = await earnings.forOwner(OWNER);
    expect(data.summary).toMatchObject({
      debtXaf: 1500,
      upcomingCount: 1,
      upcomingXaf: 4500,
      awaitingProofCount: 1,
      paidLast30DaysXaf: 4500,
    });
    expect(data.upcoming[0]).toMatchObject({
      orderId: 'vd-due',
      estimatedXaf: 4500,
    });
    expect(data.debtEntries[0]).toMatchObject({
      kind: 'REFUND_CLAWBACK',
      amountXaf: -1500,
    });
    expect(meta.total).toBe(1);

    const other = await earnings.forOwner('vd-other');
    expect(other.data.summary).toMatchObject({ debtXaf: 0, upcomingCount: 0 });
    expect(other.data.payouts).toHaveLength(0);
  });

  // ─── Notifications et invariants en base ───────────────────────────────────

  it('échec dépilé deux fois : un seul incident', async () => {
    await deliveredOrder('vd-a');
    reject = true;
    const res = await payouts.requestPayout({
      orderId: 'vd-a',
      adminUserId: ADMIN,
    });
    const event = await prisma.outboxEvent.findFirstOrThrow({
      where: { type: 'payout.failed', aggregateId: res.payout.id },
    });
    const pushes: string[] = [];
    const effects = new PayoutOutboxEffectsService(
      prisma as never,
      new OutboxService(prisma as never),
      { registerHandler: () => undefined } as never,
      {
        sendPushNotification: async (userId: string) =>
          void pushes.push(userId),
      } as never,
    );
    await effects.dispatchFailed(event);
    await effects.dispatchFailed(event);
    expect(
      await prisma.incident.count({
        where: { dedupKey: `payout_failed:${res.payout.id}` },
      }),
    ).toBe(1);
    expect(pushes[0]).toBe(OWNER);
  });

  it.each<[string, Record<string, unknown>]>([
    [
      'clawback positif',
      { kind: 'REFUND_CLAWBACK', amountXaf: 100, refundId: 'x' },
    ],
    [
      'clawback sans remboursement',
      { kind: 'REFUND_CLAWBACK', amountXaf: -100 },
    ],
    [
      'retenue négative',
      { kind: 'DEBT_SETTLED', amountXaf: -100, payoutId: 'p' },
    ],
    ['ajustement sans motif', { kind: 'ADJUSTMENT', amountXaf: 100 }],
  ])('CHECK — %s ⇒ rejet PostgreSQL', async (_label, data) => {
    await expect(
      prisma.vendorBalanceEntry.create({
        data: { restaurantId: VENDOR, ...data } as never,
      }),
    ).rejects.toThrow(/check constraint|violates/i);
  });

  it('CHECK — un versement à 0 hors NETTING est refusé', async () => {
    await deliveredOrder('vd-a');
    await expect(
      prisma.restaurantPayout.create({
        data: {
          orderId: 'vd-a',
          restaurantId: VENDOR,
          grossAmount: 5000,
          commissionPercent: 10,
          commissionAmount: 500,
          amount: 0,
          phoneNumber: '242060000070',
          providerCode: 'MTN_MOMO',
          provider: 'PAWAPAY',
        },
      }),
    ).rejects.toThrow(/check constraint|violates/i);
  });
});
