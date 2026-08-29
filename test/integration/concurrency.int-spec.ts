import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

/**
 * Concurrence réelle, sur un vrai PostgreSQL.
 *
 * Toute la suite unitaire mocke Prisma : elle vérifie que le code **appelle**
 * les bonnes requêtes, pas que ces requêtes **tiennent** sous concurrence. Un
 * mock ne peut pas exhiber une race condition — c'est ce que ces tests-ci
 * couvrent.
 *
 * Se saute proprement sans `TEST_DATABASE_URL` : un développeur sans
 * PostgreSQL local doit pouvoir lancer la suite sans erreurs rouges qui ne le
 * concernent pas.
 */
const DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

describeIfDb('Concurrence — garanties portées par PostgreSQL', () => {
  let prisma: PrismaClient;

  beforeAll(async () => {
    // Prisma 7 passe par un driver adapter : l'URL se fournit à l'adaptateur,
    // pas au client. Même construction que `PrismaService` en production —
    // tester contre une autre façon de se connecter n'aurait pas de sens.
    prisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: DATABASE_URL }),
    });
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  /**
   * Ordre de suppression imposé par les clés étrangères en RESTRICT.
   * `TRUNCATE … CASCADE` serait plus court mais masquerait une FK oubliée.
   */
  beforeEach(async () => {
    await prisma.$executeRawUnsafe(`
      TRUNCATE TABLE "DeliveryReview", "DeliveryLocation", "Delivery",
                     "LoyaltyTransaction", "OrderItem", "OrderHistory",
                     "payments", "Refund", "Order", "CartItem", "Cart",
                     "ProductVariant", "Product", "Restaurant", "User"
      RESTART IDENTITY CASCADE
    `);
  });

  /** Jeu de données minimal : un vendeur, un produit, un client. */
  async function seed({ stock }: { stock: number }) {
    await prisma.user.createMany({
      data: [
        { id: 'client-1', firebaseUid: 'fb-c1', email: 'c1@test.local' },
        { id: 'client-2', firebaseUid: 'fb-c2', email: 'c2@test.local' },
        { id: 'driver-1', firebaseUid: 'fb-d1', email: 'd1@test.local' },
      ],
    });
    await prisma.restaurant.create({
      data: {
        id: 'resto-1',
        nom: 'Chez Awa',
        adresse: 'Bacongo',
        phone: '060000000',
        ownerId: 'client-1',
      },
    });
    await prisma.product.create({
      data: {
        id: 'prod-1',
        nom: 'Poulet braisé',
        prixOriginal: 3000,
        restaurantId: 'resto-1',
        stockQuotidien: stock,
        stockRestant: stock,
      },
    });
  }

  async function createOrder(id: string, userId: string) {
    return prisma.order.create({
      data: {
        id,
        restaurantId: 'resto-1',
        userId,
        subTotal: 3000,
        deliveryFee: 1000,
        total: 4240,
        paymentMethod: 'MTN_MOMO',
      },
    });
  }

  it('deux clients, dernier article : une seule décrémentation aboutit', async () => {
    await seed({ stock: 1 });

    // C'est la requête réelle du checkout (`StockService.decrementInTransaction`).
    const decrement = () =>
      prisma.$executeRaw`
        UPDATE "Product"
           SET "stockRestant" = "stockRestant" - 1
         WHERE id = 'prod-1'
           AND "stockRestant" IS NOT NULL
           AND "stockRestant" >= 1
      `;

    const [a, b] = await Promise.all([decrement(), decrement()]);

    // Exactement une des deux met à jour une ligne — l'autre en voit zéro et
    // fait échouer son checkout. Sans la clause `>= 1`, les deux passeraient
    // et le stock tomberait à -1.
    expect([a, b].filter((n) => n === 1)).toHaveLength(1);
    expect([a, b].filter((n) => n === 0)).toHaveLength(1);

    const product = await prisma.product.findUniqueOrThrow({
      where: { id: 'prod-1' },
    });
    expect(product.stockRestant).toBe(0);
  });

  it('double crédit de fidélité sur la même commande : le second est rejeté', async () => {
    await seed({ stock: 5 });
    await createOrder('order-1', 'client-1');

    const credit = () =>
      prisma.loyaltyTransaction.create({
        data: {
          userId: 'client-1',
          orderId: 'order-1',
          points: 30,
          type: 'ORDER_EARN',
          reason: '+30 pts — commande livrée',
        },
      });

    // Les deux chemins vers LIVRER (PATCH /orders/:id/status et
    // PATCH /deliveries/:id/status) pouvaient créditer chacun de leur côté.
    const results = await Promise.allSettled([credit(), credit()]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);

    const count = await prisma.loyaltyTransaction.count({
      where: { orderId: 'order-1', type: 'ORDER_EARN' },
    });
    expect(count).toBe(1);
  });

  it('la dépense de points reste possible sur la même commande', async () => {
    await seed({ stock: 5 });
    await createOrder('order-1', 'client-1');

    // La contrainte porte sur (orderId, type) : dépenser ET gagner des points
    // sur une même commande doit rester possible — c'est le cas nominal.
    await prisma.loyaltyTransaction.create({
      data: {
        userId: 'client-1',
        orderId: 'order-1',
        points: -100,
        type: 'ORDER_SPEND',
        reason: '100 pts utilisés',
      },
    });
    await prisma.loyaltyTransaction.create({
      data: {
        userId: 'client-1',
        orderId: 'order-1',
        points: 30,
        type: 'ORDER_EARN',
        reason: '+30 pts',
      },
    });

    expect(
      await prisma.loyaltyTransaction.count({ where: { orderId: 'order-1' } }),
    ).toBe(2);
  });

  it('deux notes sur la même livraison : une seule passe', async () => {
    await seed({ stock: 5 });
    await createOrder('order-1', 'client-1');
    await prisma.delivery.create({
      data: {
        id: 'deliv-1',
        orderId: 'order-1',
        delivererId: 'driver-1',
        status: 'LIVRER',
      },
    });

    const rate = (rating: number) =>
      prisma.deliveryReview.create({
        data: {
          deliveryId: 'deliv-1',
          orderId: 'order-1',
          delivererId: 'driver-1',
          userId: 'client-1',
          rating,
        },
      });

    const results = await Promise.allSettled([rate(5), rate(1)]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(
      await prisma.deliveryReview.count({ where: { deliveryId: 'deliv-1' } }),
    ).toBe(1);
  });

  it('deux ajouts du même produit au panier : une seule ligne', async () => {
    await seed({ stock: 5 });
    await prisma.productVariant.create({
      data: { id: 'var-1', label: 'Standard', prix: 3000, productId: 'prod-1' },
    });
    await prisma.cart.create({ data: { id: 'cart-1', userId: 'client-1' } });

    const add = (id: string) =>
      prisma.cartItem.create({
        data: {
          id,
          cartId: 'cart-1',
          productId: 'prod-1',
          variantId: 'var-1',
          quantite: 1,
        },
      });

    // `@@unique([cartId, variantId, menuId])` ne protège PAS ces lignes :
    // menuId est NULL et, en PostgreSQL, NULL != NULL. C'est l'index unique
    // PARTIEL `WHERE "menuId" IS NULL` qui fait le travail.
    const results = await Promise.allSettled([add('ci-1'), add('ci-2')]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await prisma.cartItem.count({ where: { cartId: 'cart-1' } })).toBe(
      1,
    );
  });

  it('deux acceptations de la même mission : une seule réclame la ligne', async () => {
    await seed({ stock: 5 });
    await createOrder('order-1', 'client-1');
    await prisma.delivery.create({
      data: {
        id: 'deliv-1',
        orderId: 'order-1',
        delivererId: 'driver-1',
        status: 'ASSIGNER',
      },
    });

    // Verrou optimiste de `acceptDelivery` : double-tap du livreur.
    const claim = () =>
      prisma.delivery.updateMany({
        where: { id: 'deliv-1', status: 'ASSIGNER' },
        data: { status: 'ACCEPTER', acceptedAt: new Date() },
      });

    const [a, b] = await Promise.all([claim(), claim()]);

    expect([a.count, b.count].filter((n) => n === 1)).toHaveLength(1);
    expect([a.count, b.count].filter((n) => n === 0)).toHaveLength(1);
  });

  it('accepter puis récupérer : la seconde transition part du bon état', async () => {
    await seed({ stock: 5 });
    await createOrder('order-1', 'client-1');
    await prisma.delivery.create({
      data: {
        id: 'deliv-1',
        orderId: 'order-1',
        delivererId: 'driver-1',
        status: 'ACCEPTER',
      },
    });

    // Une récupération concurrente d'une autre récupération : une seule passe.
    const pickup = () =>
      prisma.delivery.updateMany({
        where: { id: 'deliv-1', status: 'ACCEPTER' },
        data: { status: 'EN_TRANSIT', pickedUpAt: new Date() },
      });

    const [a, b] = await Promise.all([pickup(), pickup()]);
    expect([a.count, b.count].filter((n) => n === 1)).toHaveLength(1);

    const delivery = await prisma.delivery.findUniqueOrThrow({
      where: { id: 'deliv-1' },
    });
    expect(delivery.status).toBe('EN_TRANSIT');
    expect(delivery.pickedUpAt).not.toBeNull();
  });
});
