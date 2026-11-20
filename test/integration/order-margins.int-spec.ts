import { PrismaPg } from '@prisma/adapter-pg';
import { OrderStatus, PrismaClient } from '@prisma/client';

import { OutboxService } from '../../apps/lilia-app/src/modules/outbox/outbox.service';
import { PaymentEventService } from '../../apps/lilia-app/src/modules/payments/services/payment-event.service';
import { RestaurantPayoutService } from '../../apps/lilia-app/src/modules/payments/services/restaurant-payout.service';
import { PayoutStateMachine } from '../../apps/lilia-app/src/modules/payments/payout-state.machine';

/**
 * Durcissement lot 5 (5E, D-3) — marge par commande sur PostgreSQL réel.
 *
 * Retrait de 5 000 de produits, 750 de frais de service, 10 % de commission :
 * revenu 750 + 500 = 1 250 avant frais prestataire ; 5 750 encaissés, 4 500
 * dus au vendeur.
 */
const DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

describeIfDb('Marge par commande (PostgreSQL réel)', () => {
  let prisma: PrismaClient;
  let payouts: RestaurantPayoutService;
  const OWNER = 'om-owner';
  const CLIENT = 'om-client';
  const VENDOR = 'om-vendor';
  const NO_RATES = { collectionFeeBps: null, payoutFeeBps: null };
  const RATES = { collectionFeeBps: 175, payoutFeeBps: 100 };

  beforeAll(async () => {
    prisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: DATABASE_URL }),
    });
    await prisma.$connect();
    payouts = new RestaurantPayoutService(
      prisma as never,
      {} as never,
      new PaymentEventService(prisma as never),
      new PayoutStateMachine(),
      new OutboxService(prisma as never),
    );
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(`
      TRUNCATE TABLE "PaymentEvent", "restaurant_payouts", "Incident",
                     "OrderItem", "OrderHistory", "payments", "Refund",
                     "OutboxEvent", "Order", "Restaurant", "User"
      RESTART IDENTITY CASCADE
    `);
    await prisma.user.createMany({
      data: [
        {
          id: OWNER,
          firebaseUid: 'fb-om-o',
          email: 'om-o@test.local',
          role: 'RESTAURATEUR',
        },
        { id: CLIENT, firebaseUid: 'fb-om-c', email: 'om-c@test.local' },
      ],
    });
    await prisma.restaurant.create({
      data: {
        id: VENDOR,
        nom: 'Chez Marge',
        adresse: 'Bacongo',
        phone: '060000075',
        ownerId: OWNER,
      },
    });
  });

  async function order(
    id: string,
    over: {
      status?: OrderStatus;
      isDelivery?: boolean;
      collectionFeeXaf?: number;
      provider?: string;
    } = {},
  ) {
    await prisma.order.create({
      data: {
        id,
        restaurantId: VENDOR,
        userId: CLIENT,
        subTotal: 5000,
        deliveryFee: 0,
        deliveryFeeGross: 0,
        serviceFee: 750,
        total: 5750,
        commissionPercent: 10,
        commissionAmount: 500,
        paymentMethod: 'MTN_MOMO',
        isDelivery: over.isDelivery ?? false,
        status: over.status ?? OrderStatus.LIVRER,
      },
    });
    await prisma.payment.create({
      data: {
        orderId: id,
        amount: 5750,
        phoneNumber: '242060000099',
        status: 'SUCCESS',
        provider: over.provider ?? 'PAWAPAY',
        method: 'MTN_MOMO',
        collectionFeeXaf: over.collectionFeeXaf ?? null,
      },
    });
  }

  const list = (rates: typeof NO_RATES | typeof RATES) =>
    payouts.listOrderMargins({ limit: 50 }, rates);

  it('sans frais connus ni taux : marge inconnue, jamais supposée nulle', async () => {
    await order('om-1');

    const { data } = await list(NO_RATES);

    expect(data.rows[0]).toMatchObject({
      marginBeforeProviderFeesXaf: 1250,
      marginXaf: null,
      quality: 'UNKNOWN',
    });
    expect(data.summary.byQuality.UNKNOWN).toBe(1);
    expect(data.summary.knownMarginXaf).toBe(0);
  });

  it('taux du contrat : marge estimée, sur l’encaissé et le net vendeur', async () => {
    await order('om-1');

    const { data } = await list(RATES);

    // 5 750 × 1,75 % = 100,625 → 101 ; 4 500 × 1 % = 45.
    expect(data.rows[0]).toMatchObject({
      collectionFee: { amountXaf: 101, quality: 'ESTIMATED' },
      payoutFee: { amountXaf: 45, quality: 'ESTIMATED' },
      marginXaf: 1104,
      quality: 'ESTIMATED',
    });
  });

  it('paiement MANUAL : pas de frais pawaPay estimé, encaissement inconnu', async () => {
    await order('om-1', { provider: 'MANUAL' });

    const { data } = await list(RATES);

    expect(data.rows[0]).toMatchObject({
      collectionFee: { amountXaf: null, quality: 'UNKNOWN' },
      payoutFee: { amountXaf: 45, quality: 'ESTIMATED' },
      marginXaf: null,
      quality: 'UNKNOWN',
    });
  });

  it('un frais réel prime sur le taux, poste par poste', async () => {
    await order('om-1', { collectionFeeXaf: 120 });

    const { data } = await list(RATES);

    expect(data.rows[0]).toMatchObject({
      collectionFee: { amountXaf: 120, quality: 'CONFIRMED' },
      payoutFee: { amountXaf: 45, quality: 'ESTIMATED' },
      marginXaf: 1085,
      quality: 'ESTIMATED',
    });
  });

  it('livraison sans coût livreur figé : marge inconnue malgré les taux', async () => {
    await order('om-1', { isDelivery: true });

    const { data } = await list(RATES);

    expect(data.rows[0]).toMatchObject({
      marginBeforeProviderFeesXaf: null,
      marginXaf: null,
      quality: 'UNKNOWN',
    });
  });

  it('seules les commandes livrées comptent', async () => {
    await order('om-1');
    await order('om-2', { status: OrderStatus.PAYER });

    const { data } = await list(RATES);

    expect(data.rows.map((r) => r.orderId)).toEqual(['om-1']);
    expect(data.summary.orders).toBe(1);
  });

  it('la synthèse couvre la période, les lignes sont bornées par `limit`', async () => {
    await order('om-1');
    await order('om-2');

    const { data } = await payouts.listOrderMargins({ limit: 1 }, RATES);

    expect(data.rows).toHaveLength(1);
    expect(data.summary.orders).toBe(2);
    expect(data.summary.knownMarginXaf).toBe(2208);
  });

  it('sans `from` : seuls les 30 derniers jours comptent', async () => {
    await order('om-1');
    await order('om-old');
    await prisma.order.update({
      where: { id: 'om-old' },
      data: { createdAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000) },
    });

    const { data } = await list(RATES);

    expect(data.rows.map((r) => r.orderId)).toEqual(['om-1']);
    expect(data.summary.orders).toBe(1);
  });

  it('`from` après `to` : 400 MARGINS_PERIOD_INVALID', async () => {
    await expect(
      payouts.listOrderMargins(
        { from: '2026-11-20', to: '2026-11-19', limit: 50 },
        RATES,
      ),
    ).rejects.toMatchObject({
      response: { code: 'MARGINS_PERIOD_INVALID' },
    });
  });

  it('aucune écriture', async () => {
    await order('om-1');
    const before = await prisma.restaurantPayout.count();

    await list(RATES);

    expect(await prisma.restaurantPayout.count()).toBe(before);
  });
});
