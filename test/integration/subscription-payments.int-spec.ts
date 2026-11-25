import { PrismaPg } from '@prisma/adapter-pg';
import { PaymentEventSource, PrismaClient } from '@prisma/client';

import { OutboxService } from '../../apps/lilia-app/src/modules/outbox/outbox.service';
import { PaymentEventService } from '../../apps/lilia-app/src/modules/payments/services/payment-event.service';
import { PlatformSettingsService } from '../../apps/lilia-app/src/modules/platform-settings/platform-settings.service';
import { SubscriptionPaymentService } from '../../apps/lilia-app/src/modules/subscriptions/subscription-payment.service';
import { VendorSubscriptionService } from '../../apps/lilia-app/src/modules/subscriptions/vendor-subscription.service';
import { SubscriptionReminderService } from '../../apps/lilia-app/src/modules/schedule/subscription-reminder.service';

/**
 * **Premium S1 — le vendeur paie son abonnement par pawaPay (PostgreSQL réel).**
 *
 * Le prestataire est simulé ; tout le reste est réel : index unique partiel,
 * CHECK, verrous, transaction « SUCCESS ⇔ mois créés », clés d'idempotence.
 */
const DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

describeIfDb('Paiement d’abonnement Premium (PostgreSQL réel)', () => {
  let prisma: PrismaClient;
  let service: SubscriptionPaymentService;
  let subscriptions: VendorSubscriptionService;
  let reminders: SubscriptionReminderService;

  const OWNER = 'sp-owner';
  const OTHER_OWNER = 'sp-owner-2';
  const ADMIN = 'sp-admin';
  const VENDOR = 'sp-vendor';
  const PHONE = '242061234567';

  const deposits: { id: string; amountXaf: number }[] = [];
  let collectionAccepted = true;
  const provider = {
    name: 'PAWAPAY',
    supportsCollection: true,
    createCollection: async (input: {
      providerTransactionId: string;
      amountXaf: number;
    }) => {
      deposits.push({
        id: input.providerTransactionId,
        amountXaf: input.amountXaf,
      });
      return collectionAccepted
        ? { accepted: true, duplicate: false, raw: {} }
        : {
            accepted: false,
            duplicate: false,
            failureCode: 'INVALID_PHONE_NUMBER',
            failureMessage: 'Numéro invalide',
            raw: {},
          };
    },
    getCollectionStatus: async () => null,
  };

  const success = (amountXaf: number) => ({
    state: 'SUCCESS' as const,
    rawStatus: 'COMPLETED',
    amountXaf,
    currency: 'XAF',
    raw: {},
  });
  const failed = {
    state: 'FAILED' as const,
    rawStatus: 'FAILED',
    failureCode: 'INSUFFICIENT_BALANCE',
    raw: {},
  };

  beforeAll(async () => {
    prisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: DATABASE_URL }),
    });
    await prisma.$connect();
    const registry = {
      forNewTransaction: () => provider,
      forStoredProvider: () => provider,
    };
    const settings = new PlatformSettingsService(prisma as never);
    const outbox = new OutboxService(prisma as never);
    service = new SubscriptionPaymentService(
      prisma as never,
      settings,
      registry as never,
      new PaymentEventService(prisma as never),
      outbox,
    );
    subscriptions = new VendorSubscriptionService(prisma as never, settings);
    reminders = new SubscriptionReminderService(prisma as never, outbox, {
      runExclusively: async (_n: string, _t: number, fn: () => Promise<void>) =>
        fn(),
    } as never);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    deposits.length = 0;
    collectionAccepted = true;
    await prisma.$executeRawUnsafe(`
      TRUNCATE TABLE "VendorSubscription", "SubscriptionPayment", "PaymentEvent",
                     "OutboxEvent", "Incident", "AdminAuditLog", "PlatformSettings",
                     "Restaurant", "User"
      RESTART IDENTITY CASCADE
    `);
    // Ligne `singleton` au prix décidé le 25/11 (défaut de la colonne).
    await prisma.platformSettings.create({ data: { id: 'singleton' } });
    await prisma.user.createMany({
      data: [
        {
          id: OWNER,
          firebaseUid: 'fb-sp-1',
          email: 'sp1@test.local',
          role: 'RESTAURATEUR',
        },
        {
          id: OTHER_OWNER,
          firebaseUid: 'fb-sp-2',
          email: 'sp2@test.local',
          role: 'RESTAURATEUR',
        },
        {
          id: ADMIN,
          firebaseUid: 'fb-sp-3',
          email: 'sp3@test.local',
          role: 'ADMIN',
        },
      ],
    });
    await prisma.restaurant.create({
      data: {
        id: VENDOR,
        nom: 'Chez Test',
        adresse: 'Poto-Poto',
        phone: '060000000',
        ownerId: OWNER,
        adminApproved: true,
      },
    });
    await prisma.restaurant.create({
      data: {
        id: 'sp-vendor-2',
        nom: 'Autre',
        adresse: 'Bacongo',
        phone: '060000001',
        ownerId: OTHER_OWNER,
        adminApproved: true,
      },
    });
  });

  const periods = () =>
    prisma.vendorSubscription.findMany({
      where: { restaurantId: VENDOR },
      orderBy: { startsAt: 'asc' },
    });

  it('prix lu dans les réglages (25 000) et figé ; montant = mois × prix', async () => {
    const offer = await service.offerForOwner(OWNER);
    expect(offer.unitPriceXaf).toBe(25000);
    expect(offer.durations).toEqual([
      { months: 1, amountXaf: 25000 },
      { months: 3, amountXaf: 75000 },
      { months: 6, amountXaf: 150000 },
      { months: 12, amountXaf: 300000 },
    ]);
    expect(offer.canPay).toBe(true);

    const p = await service.startForOwner(OWNER, {
      months: 3,
      phoneNumber: PHONE,
      method: 'MTN_MOMO',
    });
    expect(p).toMatchObject({
      months: 3,
      unitPriceXaf: 25000,
      amountXaf: 75000,
      status: 'PENDING',
    });
    expect(deposits).toEqual([{ id: expect.any(String), amountXaf: 75000 }]);
    // Aucun mois tant que le prestataire n'a rien confirmé (règle 3).
    expect(await periods()).toHaveLength(0);
  });

  it('SUCCESS → 3 mois empilés, avis outbox écrit, rejeu sans effet', async () => {
    const p = await service.startForOwner(OWNER, {
      months: 3,
      phoneNumber: PHONE,
      method: 'MTN_MOMO',
    });

    const first = await service.applyProviderStatus({
      paymentId: p.id,
      status: success(75000),
      source: PaymentEventSource.WEBHOOK,
    });
    const replay = await service.applyProviderStatus({
      paymentId: p.id,
      status: success(75000),
      source: PaymentEventSource.RECONCILIATION,
    });

    expect(first).toBe('APPLIED');
    expect(replay).toBe('DUPLICATE');
    const rows = await periods();
    expect(rows).toHaveLength(3);
    expect(
      rows.every(
        (r) =>
          r.paymentMethod === 'PAWAPAY' &&
          r.priceXaf === 25000 &&
          r.subscriptionPaymentId === p.id,
      ),
    ).toBe(true);
    // Suite continue : chaque mois commence où finit le précédent.
    expect(rows[1].startsAt).toEqual(rows[0].endsAt);
    expect(rows[2].startsAt).toEqual(rows[1].endsAt);
    const outbox = await prisma.outboxEvent.findMany({
      where: { type: 'subscription.activated' },
    });
    expect(outbox).toHaveLength(1);
    const verdict = await subscriptions.verdictFor(VENDOR);
    expect(verdict.active).toBe(true);
    expect(verdict.entitlements).toContain('ON_SITE_RESERVATIONS');
    expect(verdict.paidUntil).toEqual(rows[2].endsAt);
  });

  it('deux SUCCESS simultanés → un seul jeu de mois', async () => {
    const p = await service.startForOwner(OWNER, {
      months: 1,
      phoneNumber: PHONE,
      method: 'AIRTEL_MONEY',
    });
    const results = await Promise.all([
      service.applyProviderStatus({
        paymentId: p.id,
        status: success(25000),
        source: PaymentEventSource.WEBHOOK,
      }),
      service.applyProviderStatus({
        paymentId: p.id,
        status: success(25000),
        source: PaymentEventSource.CLIENT_POLL,
      }),
    ]);
    expect(results.sort()).toEqual(['APPLIED', 'DUPLICATE']);
    expect(await periods()).toHaveLength(1);
  });

  it('une seule tentative en cours ; après un échec, le vendeur réessaie', async () => {
    const p = await service.startForOwner(OWNER, {
      months: 1,
      phoneNumber: PHONE,
      method: 'MTN_MOMO',
    });
    await expect(
      service.startForOwner(OWNER, {
        months: 6,
        phoneNumber: PHONE,
        method: 'MTN_MOMO',
      }),
    ).rejects.toMatchObject({
      response: { code: 'SUBSCRIPTION_PAYMENT_PENDING' },
    });

    expect(
      await service.applyProviderStatus({
        paymentId: p.id,
        status: failed,
        source: PaymentEventSource.WEBHOOK,
      }),
    ).toBe('APPLIED');
    expect(await periods()).toHaveLength(0);

    const retry = await service.startForOwner(OWNER, {
      months: 6,
      phoneNumber: PHONE,
      method: 'AIRTEL_MONEY',
    });
    expect(retry).toMatchObject({ status: 'PENDING', amountXaf: 150000 });
  });

  it('refus immédiat de l’opérateur → FAILED, nouvelle tentative possible', async () => {
    collectionAccepted = false;
    await expect(
      service.startForOwner(OWNER, {
        months: 1,
        phoneNumber: PHONE,
        method: 'MTN_MOMO',
      }),
    ).rejects.toMatchObject({
      response: { code: 'SUBSCRIPTION_PAYMENT_REJECTED' },
    });
    const rows = await prisma.subscriptionPayment.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: 'FAILED',
      failureCode: 'INVALID_PHONE_NUMBER',
    });

    collectionAccepted = true;
    await expect(
      service.startForOwner(OWNER, {
        months: 1,
        phoneNumber: PHONE,
        method: 'MTN_MOMO',
      }),
    ).resolves.toMatchObject({ status: 'PENDING' });
  });

  it('SUCCESS tardif après clôture en échec → mois accordés quand même (décision du 25/11)', async () => {
    const p = await service.startForOwner(OWNER, {
      months: 1,
      phoneNumber: PHONE,
      method: 'MTN_MOMO',
    });
    expect(await service.abandon(p.id)).toBe(true);

    const outcome = await service.applyProviderStatus({
      paymentId: p.id,
      status: success(25000),
      source: PaymentEventSource.WEBHOOK,
    });
    expect(outcome).toBe('APPLIED');
    expect(await periods()).toHaveLength(1);
    const row = await prisma.subscriptionPayment.findUniqueOrThrow({
      where: { id: p.id },
    });
    expect(row).toMatchObject({ status: 'SUCCESS', failureCode: null });
    expect(row.grantedAt).not.toBeNull();
  });

  it('FAILED après SUCCESS ne défait rien', async () => {
    const p = await service.startForOwner(OWNER, {
      months: 1,
      phoneNumber: PHONE,
      method: 'MTN_MOMO',
    });
    await service.applyProviderStatus({
      paymentId: p.id,
      status: success(25000),
      source: PaymentEventSource.WEBHOOK,
    });
    expect(
      await service.applyProviderStatus({
        paymentId: p.id,
        status: failed,
        source: PaymentEventSource.WEBHOOK,
      }),
    ).toBe('DUPLICATE');
    expect(await periods()).toHaveLength(1);
  });

  it('montant annoncé différent → aucun mois, incident CRITICAL ouvert une fois', async () => {
    const p = await service.startForOwner(OWNER, {
      months: 3,
      phoneNumber: PHONE,
      method: 'MTN_MOMO',
    });
    expect(
      await service.applyProviderStatus({
        paymentId: p.id,
        status: success(25000),
        source: PaymentEventSource.WEBHOOK,
      }),
    ).toBe('MISMATCH');
    expect(
      await service.applyProviderStatus({
        paymentId: p.id,
        status: success(25000),
        source: PaymentEventSource.RECONCILIATION,
      }),
    ).toBe('MISMATCH');
    expect(await periods()).toHaveLength(0);
    const incidents = await prisma.incident.findMany();
    expect(incidents).toHaveLength(1);
    expect(incidents[0].severity).toBe('CRITICAL');
  });

  it('les mois payés s’empilent après un mois attribué par un administrateur', async () => {
    const [manual] = [
      (
        await subscriptions.grant({
          restaurantId: VENDOR,
          adminId: ADMIN,
          requestKey: 'manual-1',
          paymentMethod: 'CASH',
        })
      ).subscription,
    ];
    const p = await service.startForOwner(OWNER, {
      months: 1,
      phoneNumber: PHONE,
      method: 'MTN_MOMO',
    });
    await service.applyProviderStatus({
      paymentId: p.id,
      status: success(25000),
      source: PaymentEventSource.WEBHOOK,
    });
    const rows = await periods();
    expect(rows).toHaveLength(2);
    expect(rows[1].startsAt).toEqual(manual.endsAt);
  });

  it('ownership : un vendeur ne lit pas le paiement d’un autre', async () => {
    const p = await service.startForOwner(OWNER, {
      months: 1,
      phoneNumber: PHONE,
      method: 'MTN_MOMO',
    });
    await expect(service.findForOwner(OTHER_OWNER, p.id)).rejects.toMatchObject(
      { status: 404 },
    );
    await expect(service.findForOwner(OWNER, p.id)).resolves.toMatchObject({
      id: p.id,
    });
  });

  it('vendeur non validé : pas de paiement', async () => {
    await prisma.restaurant.update({
      where: { id: VENDOR },
      data: { adminApproved: false },
    });
    await expect(
      service.startForOwner(OWNER, {
        months: 1,
        phoneNumber: PHONE,
        method: 'MTN_MOMO',
      }),
    ).rejects.toMatchObject({ response: { code: 'VENDOR_NOT_APPROVED' } });
    expect(deposits).toHaveLength(0);
  });

  it('rappel J-3 programmé une seule fois par échéance', async () => {
    const now = new Date();
    await prisma.vendorSubscription.create({
      data: {
        restaurantId: VENDOR,
        plan: 'PREMIUM',
        startsAt: new Date(now.getTime() - 27 * 24 * 3600_000),
        endsAt: new Date(now.getTime() + 60 * 3600_000),
        priceXaf: 25000,
        paymentMethod: 'CASH',
        requestKey: 'rem-1',
        grantedById: ADMIN,
      },
    });
    expect(await reminders.remind(now)).toBe(1);
    expect(await reminders.remind(now)).toBe(0);
    const ev = await prisma.outboxEvent.findMany({
      where: { type: 'subscription.expiring' },
    });
    expect(ev).toHaveLength(1);
    expect((ev[0].payload as { tier: string }).tier).toBe('J3');
  });
});
