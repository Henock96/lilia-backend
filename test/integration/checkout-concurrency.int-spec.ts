import { PrismaPg } from '@prisma/adapter-pg';
import { ConflictException } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';

import { OrderCheckoutService } from '../../apps/lilia-app/src/modules/orders/order-checkout.service';

/**
 * **F-11 (Master Audit v1) — un panier ne se paie qu'une fois, et c'est
 * PostgreSQL qui l'arbitre.**
 *
 * L'idempotence Redis protège un même geste rejoué (même clé). Elle ne protège
 * pas deux gestes distincts sur le même panier — l'app ET le web, deux onglets,
 * ou n'importe quel checkout pendant une panne Redis (l'idempotence s'y dégrade
 * en best-effort). Les deux lisaient le même panier et créaient deux commandes.
 *
 * On exécute ici, sur deux connexions réelles et en parallèle, la section
 * critique exacte du checkout : verrou + relecture sous verrou
 * (`lockCartAndAssertUnchanged`, le code de production), création de la
 * commande, vidage des lignes commandées.
 */
const DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

describeIfDb(
  'Checkout — double soumission du même panier (PostgreSQL réel)',
  () => {
    let prisma: PrismaClient;
    let checkout: OrderCheckoutService;

    const CLIENT = 'cc-client';
    const VENDOR = 'cc-vendor';
    const OWNER = 'cc-owner';
    const CART = 'cc-cart';

    beforeAll(async () => {
      prisma = new PrismaClient({
        adapter: new PrismaPg({ connectionString: DATABASE_URL }),
      });
      await prisma.$connect();
      // Seules les dépendances touchées par la section critique sont réelles.
      const unused = {} as never;
      checkout = new OrderCheckoutService(
        prisma as never,
        unused, // eventEmitter
        unused, // validator
        unused, // calculator
        unused, // promo
        unused, // stock
        { get: () => undefined } as never, // config (Redis désactivé)
        unused, // platformSettings
        unused, // preorderValidator
        unused, // quartiers
        unused, // destination
        unused, // deliveryPricing
        unused, // transitions,
        { announce: async () => undefined } as never, // StockSignalService (F3-10)
      );
    });

    afterAll(async () => {
      await prisma.$disconnect();
    });

    beforeEach(async () => {
      await prisma.$executeRawUnsafe(`
      TRUNCATE TABLE "OrderItem", "OrderHistory", "payments", "Refund",
                     "Order", "CartItem", "Cart", "ProductVariant", "Product",
                     "Restaurant", "User"
      RESTART IDENTITY CASCADE
    `);
      await prisma.user.createMany({
        data: [
          { id: CLIENT, firebaseUid: 'fb-cc-c', email: 'cc-c@test.local' },
          { id: OWNER, firebaseUid: 'fb-cc-o', email: 'cc-o@test.local' },
        ],
      });
      await prisma.restaurant.create({
        data: {
          id: VENDOR,
          nom: 'Chez Course',
          adresse: 'Bacongo',
          phone: '060000020',
          ownerId: OWNER,
        },
      });
      // Stock ILLIMITÉ : c'est le cas où rien d'autre ne protégeait.
      await prisma.product.create({
        data: {
          id: 'cc-prod',
          nom: 'Saka-saka',
          prixOriginal: 2000,
          restaurantId: VENDOR,
          variants: { create: { id: 'cc-var', prix: 2000 } },
        },
      });
      await prisma.cart.create({
        data: {
          id: CART,
          userId: CLIENT,
          items: {
            create: {
              id: 'cc-line',
              productId: 'cc-prod',
              variantId: 'cc-var',
              quantite: 2,
            },
          },
        },
      });
    });

    /** La section critique du checkout, telle qu'exécutée en production. */
    const submit = async (snapshot: { id: string; quantite: number }[]) =>
      prisma.$transaction(async (tx) => {
        await (
          checkout as unknown as {
            lockCartAndAssertUnchanged: (
              tx: Prisma.TransactionClient,
              cartId: string,
              snapshot: { id: string; quantite: number }[],
            ) => Promise<void>;
          }
        ).lockCartAndAssertUnchanged(tx, CART, snapshot);
        // Laisse à l'autre transaction le temps d'arriver sur le verrou.
        await new Promise((r) => setTimeout(r, 50));
        const order = await tx.order.create({
          data: {
            userId: CLIENT,
            restaurantId: VENDOR,
            subTotal: 4000,
            deliveryFee: 0,
            total: 4000,
            paymentMethod: 'MTN_MOMO',
          },
        });
        await tx.cartItem.deleteMany({
          where: { cartId: CART, id: { in: snapshot.map((l) => l.id) } },
        });
        return order;
      });

    it('deux soumissions simultanées du même panier : une commande, un 409', async () => {
      const snapshot = [{ id: 'cc-line', quantite: 2 }];
      const results = await Promise.allSettled([
        submit(snapshot),
        submit(snapshot),
        submit(snapshot),
        submit(snapshot),
        submit(snapshot),
      ]);

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      for (const r of results.filter((r) => r.status === 'rejected')) {
        expect((r as PromiseRejectedResult).reason).toBeInstanceOf(
          ConflictException,
        );
      }
      expect(await prisma.order.count({ where: { userId: CLIENT } })).toBe(1);
      expect(await prisma.cartItem.count({ where: { cartId: CART } })).toBe(0);
    });

    it('panier modifié entre le calcul et la transaction : refusé, rien n’est écrit', async () => {
      await prisma.cartItem.update({
        where: { id: 'cc-line' },
        data: { quantite: 5 },
      });
      await expect(submit([{ id: 'cc-line', quantite: 2 }])).rejects.toThrow(
        /a changé pendant la validation/,
      );
      expect(await prisma.order.count()).toBe(0);
      expect(
        (await prisma.cartItem.findUniqueOrThrow({ where: { id: 'cc-line' } }))
          .quantite,
      ).toBe(5);
    });
  },
);
