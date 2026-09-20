import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

import { OrderTransitionService } from '../../apps/lilia-app/src/modules/orders/order-transition.service';

/**
 * `OrderHistory` — atomicité et concurrence contre un vrai PostgreSQL.
 *
 * ## Pourquoi ces tests-ci, en plus des tests unitaires
 *
 * Toute la suite unitaire mocke Prisma : elle prouve que le service **appelle**
 * `orderHistory.create` dans le même `tx`, pas qu'une transaction PostgreSQL
 * **annule réellement** les deux écritures quand la seconde échoue. Un mock ne
 * peut pas exhiber un rollback, ni une course entre deux transactions.
 *
 * Or c'est exactement la garantie que ce chantier vend : il ne peut pas exister
 * de commande en `PRET` sans ligne `PRET`. Elle doit être prouvée là où elle
 * s'applique.
 *
 * Se saute proprement sans `TEST_DATABASE_URL`.
 */
const DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

describeIfDb('OrderHistory — atomicité réelle (P0-4)', () => {
  let prisma: PrismaClient;
  let transitions: OrderTransitionService;

  beforeAll(async () => {
    prisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: DATABASE_URL }),
    });
    await prisma.$connect();
    transitions = new OrderTransitionService();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(`
      TRUNCATE TABLE "DeliveryReview", "DeliveryLocation", "Delivery",
                     "ReferralReward", "DeviceInstallation",
                     "LoyaltyTransaction", "OrderItem", "OrderHistory",
                     "payments", "Refund", "Order", "CartItem", "Cart",
                     "ProductVariant", "Product", "Restaurant", "User"
      RESTART IDENTITY CASCADE
    `);

    await prisma.user.create({
      data: { id: 'u-1', firebaseUid: 'fb-1', email: 'c1@test.local' },
    });
    await prisma.restaurant.create({
      data: {
        id: 'r-1',
        nom: 'Chez Awa',
        adresse: 'Bacongo',
        phone: '060000000',
        ownerId: 'u-1',
      },
    });
  });

  async function createOrder(status: 'EN_ATTENTE' | 'EN_PREPARATION') {
    return prisma.order.create({
      data: {
        id: 'o-1',
        restaurantId: 'r-1',
        userId: 'u-1',
        subTotal: 3000,
        deliveryFee: 1000,
        total: 4240,
        paymentMethod: 'MTN_MOMO',
        status,
      },
    });
  }

  it('une transition écrit le statut ET sa ligne, durablement', async () => {
    await createOrder('EN_PREPARATION');

    await prisma.$transaction((tx) =>
      transitions.transition(tx, {
        orderId: 'o-1',
        from: 'EN_PREPARATION',
        to: 'PRET',
        actor: 'RESTAURATEUR',
        actorUserId: 'u-1',
        source: 'APP',
      }),
    );

    const order = await prisma.order.findUniqueOrThrow({
      where: { id: 'o-1' },
    });
    const history = await prisma.orderHistory.findMany({
      where: { orderId: 'o-1' },
    });

    expect(order.status).toBe('PRET');
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      fromStatus: 'EN_PREPARATION',
      toStatus: 'PRET',
      actionId: 'RESTAURATEUR',
      actorUserId: 'u-1',
      source: 'APP',
    });
  });

  it('la création accepte `fromStatus = null` — la colonne est bien nullable', async () => {
    // C'est le point que la migration change. Si la contrainte `NOT NULL`
    // n'avait pas été levée, cette insertion échouerait ici et nulle part
    // ailleurs : aucun test unitaire ne parle à PostgreSQL.
    await createOrder('EN_ATTENTE');

    await prisma.$transaction((tx) =>
      transitions.recordCreation(tx, {
        orderId: 'o-1',
        to: 'EN_ATTENTE',
        actor: 'CLIENT',
        actorUserId: 'u-1',
        source: 'APP',
      }),
    );

    const [row] = await prisma.orderHistory.findMany({
      where: { orderId: 'o-1' },
    });
    expect(row.fromStatus).toBeNull();
    expect(row.toStatus).toBe('EN_ATTENTE');
  });

  it('ROLLBACK : si la transaction échoue après la transition, le statut ne bouge pas', async () => {
    await createOrder('EN_PREPARATION');

    await expect(
      prisma.$transaction(async (tx) => {
        await transitions.transition(tx, {
          orderId: 'o-1',
          from: 'EN_PREPARATION',
          to: 'PRET',
          actor: 'RESTAURATEUR',
          actorUserId: 'u-1',
          source: 'APP',
        });
        // Simule un échec de la suite du traitement (restauration de stock,
        // compensation de fidélité, écriture d'outbox…).
        throw new Error('échec en aval');
      }),
    ).rejects.toThrow('échec en aval');

    const order = await prisma.order.findUniqueOrThrow({
      where: { id: 'o-1' },
    });
    const history = await prisma.orderHistory.findMany({
      where: { orderId: 'o-1' },
    });

    // Ni l'un, ni l'autre. C'est la garantie centrale du chantier : il ne peut
    // pas exister de statut sans historique, ni d'historique sans statut.
    expect(order.status).toBe('EN_PREPARATION');
    expect(history).toHaveLength(0);
  });

  it('CONCURRENCE : deux acteurs, une seule transition et une seule ligne', async () => {
    await createOrder('EN_PREPARATION');

    // Le vendeur passe la commande en PRET pendant qu'un administrateur
    // l'annule. Les deux ont lu `EN_PREPARATION`.
    const vendeur = prisma.$transaction((tx) =>
      transitions.transition(tx, {
        orderId: 'o-1',
        from: 'EN_PREPARATION',
        to: 'PRET',
        actor: 'RESTAURATEUR',
        actorUserId: 'u-1',
        source: 'APP',
      }),
    );
    const admin = prisma.$transaction((tx) =>
      transitions.transition(tx, {
        orderId: 'o-1',
        from: 'EN_PREPARATION',
        to: 'ANNULER',
        actor: 'ADMIN',
        actorUserId: 'u-1',
        source: 'ADMIN_APP',
      }),
    );

    const results = await Promise.allSettled([vendeur, admin]);
    const gagnants = results.filter((r) => r.status === 'fulfilled');
    const perdants = results.filter((r) => r.status === 'rejected');

    expect(gagnants).toHaveLength(1);
    expect(perdants).toHaveLength(1);

    const order = await prisma.order.findUniqueOrThrow({
      where: { id: 'o-1' },
    });
    const history = await prisma.orderHistory.findMany({
      where: { orderId: 'o-1' },
    });

    // Une transition, une ligne — et la ligne décrit celle qui a gagné.
    expect(history).toHaveLength(1);
    expect(history[0].toStatus).toBe(order.status);
  });

  it('CONCURRENCE : trois sources de paiement, une seule ligne PAYER', async () => {
    // Webhook, sondage client et cron de réconciliation peuvent arriver à la
    // même seconde. Le verrou `WHERE status = EN_ATTENTE` est ce qui garantit
    // qu'une seule écrit — et donc qu'une seule ligne d'historique existe.
    await createOrder('EN_ATTENTE');

    const attempt = (source: 'WEBHOOK' | 'POLLING' | 'CRON') =>
      prisma.$transaction((tx) =>
        transitions.tryTransition(tx, {
          orderId: 'o-1',
          from: 'EN_ATTENTE',
          to: 'PAYER',
          actor: 'SYSTEM',
          source,
          data: { paidAt: new Date() },
        }),
      );

    const outcomes = await Promise.all([
      attempt('WEBHOOK'),
      attempt('POLLING'),
      attempt('CRON'),
    ]);

    expect(outcomes.filter((o) => o.moved)).toHaveLength(1);

    const history = await prisma.orderHistory.findMany({
      where: { orderId: 'o-1' },
    });
    expect(history).toHaveLength(1);
    expect(history[0].toStatus).toBe('PAYER');

    const order = await prisma.order.findUniqueOrThrow({
      where: { id: 'o-1' },
    });
    expect(order.paidAt).not.toBeNull();
  });

  it('les durées par étape deviennent calculables', async () => {
    // L'objectif du chantier, vérifié sur des lignes réelles : sans cette
    // table, `Order.updatedAt` était le seul horodatage disponible — et il
    // bouge à chaque écriture, donc il ne mesure rien.
    await createOrder('EN_ATTENTE');

    for (const [from, to] of [
      ['EN_ATTENTE', 'PAYER'],
      ['PAYER', 'EN_PREPARATION'],
      ['EN_PREPARATION', 'PRET'],
    ] as const) {
      await prisma.$transaction((tx) =>
        transitions.transition(tx, {
          orderId: 'o-1',
          from,
          to,
          actor: 'RESTAURATEUR',
          actorUserId: 'u-1',
          source: 'APP',
        }),
      );
    }

    const history = await prisma.orderHistory.findMany({
      where: { orderId: 'o-1' },
      orderBy: { createdAt: 'asc' },
    });

    expect(history.map((h) => h.toStatus)).toEqual([
      'PAYER',
      'EN_PREPARATION',
      'PRET',
    ]);

    // Temps passé en préparation = entrée dans PRET − entrée dans EN_PREPARATION.
    const entreePreparation = history[1].createdAt.getTime();
    const entreePret = history[2].createdAt.getTime();
    expect(entreePret - entreePreparation).toBeGreaterThanOrEqual(0);
  });
});
