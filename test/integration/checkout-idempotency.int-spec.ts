import { PrismaPg } from '@prisma/adapter-pg';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaClient } from '@prisma/client';

import { OrderCheckoutService } from '../../apps/lilia-app/src/modules/orders/order-checkout.service';
import { OrderValidatorService } from '../../apps/lilia-app/src/modules/orders/order-validator.service';
import { OrderCalculatorService } from '../../apps/lilia-app/src/modules/orders/order-calculator.service';
import { StockService } from '../../apps/lilia-app/src/modules/orders/stock.service';
import { PreorderValidatorService } from '../../apps/lilia-app/src/modules/vendors/preorder-validator.service';

/**
 * Durcissement lot 4 — idempotence du checkout portée par PostgreSQL, sans
 * Redis.
 *
 *  - même clé envoyée N fois en parallèle (double-tap, retry réseau) : une
 *    seule commande, et CHAQUE requête reçoit cette commande ;
 *  - rejeu après succès (réponse perdue) : la même commande, rien de recréé ;
 *  - la même clé chez un autre client crée sa propre commande ;
 *  - l'index unique refuse une seconde commande portant la clé.
 */
const DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

describeIfDb('Checkout — idempotence en base (PostgreSQL réel)', () => {
  let prisma: PrismaClient;
  let checkout: OrderCheckoutService;
  const dto = { paymentMethod: 'MTN_MOMO', isDelivery: false } as never;

  beforeAll(async () => {
    prisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: DATABASE_URL }),
    });
    await prisma.$connect();
    const settings = {
      getSettings: async () => ({
        modifiersEnabled: false,
        serviceFeePercent: 15,
        restaurantCommissionPercent: 0,
        deliveryPricingMode: 'VENDOR_LEGACY',
        loyaltyMinRedemption: 100,
        loyaltyPointValueXaf: 50,
      }),
    };
    checkout = new OrderCheckoutService(
      prisma as never,
      new EventEmitter2(),
      new OrderValidatorService(
        prisma as never,
        {} as never,
        { decide: async () => ({ open: true }) } as never,
      ),
      new OrderCalculatorService(),
      {} as never, // promo
      new StockService(),
      settings as never,
      new PreorderValidatorService(prisma as never),
      {} as never, // quartiers — retrait
      {} as never, // destination — retrait
      {} as never, // tarification — mode historique
      { recordCreation: async () => undefined } as never,
      { announce: async () => undefined } as never,
      { resolveForCart: async () => null } as never, // offres (F3-11)
    );
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(`
      TRUNCATE TABLE "User", "Restaurant", "Product", "Cart", "Order"
      RESTART IDENTITY CASCADE
    `);
    await prisma.user.create({
      data: {
        id: 'ik-o',
        firebaseUid: 'fb-ik-o',
        email: 'ik-o@t.local',
        role: 'RESTAURATEUR',
      },
    });
    await prisma.restaurant.create({
      data: {
        id: 'ik-v',
        nom: 'Chez Clé',
        adresse: 'Bacongo',
        phone: '060000074',
        ownerId: 'ik-o',
        adminApproved: true,
        isActive: true,
        onboardingStatus: 'ACTIVATED',
      },
    });
    await prisma.product.create({
      data: {
        id: 'ik-p',
        nom: 'Saka-saka',
        prixOriginal: 2500,
        restaurantId: 'ik-v',
        variants: { create: { id: 'ik-vp', prix: 2500 } },
      },
    });
    for (const c of ['ik-a', 'ik-b']) {
      await prisma.user.create({
        data: { id: c, firebaseUid: `fb-${c}`, email: `${c}@t.local` },
      });
      await prisma.cart.create({
        data: {
          userId: c,
          items: {
            create: { productId: 'ik-p', variantId: 'ik-vp', quantite: 1 },
          },
        },
      });
    }
  });

  it('même clé ×8 en parallèle : une commande, renvoyée à chaque requête', async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        checkout.createOrderFromCart('fb-ik-a', dto, 'tap-1'),
      ),
    );

    expect(await prisma.order.count()).toBe(1);
    const ids = new Set(results.map((r) => r.data.id));
    expect(ids.size).toBe(1);
    const order = await prisma.order.findFirstOrThrow();
    expect(order.idempotencyKey).toBe('tap-1');
    expect([...ids][0]).toBe(order.id);
  });

  it('rejeu après succès : la même commande, rien de recréé', async () => {
    const first = await checkout.createOrderFromCart('fb-ik-a', dto, 'k-1');
    const again = await checkout.createOrderFromCart('fb-ik-a', dto, 'k-1');

    expect(again.data.id).toBe(first.data.id);
    expect(again.data.items).toHaveLength(1);
    expect(again.data.restaurant.nom).toBe('Chez Clé');
    expect(await prisma.order.count()).toBe(1);
  });

  it('la même clé chez un autre client crée sa propre commande', async () => {
    const a = await checkout.createOrderFromCart('fb-ik-a', dto, 'commune');
    const b = await checkout.createOrderFromCart('fb-ik-b', dto, 'commune');

    expect(a.data.id).not.toBe(b.data.id);
    expect(b.data.userId).toBe('ik-b');
  });

  it("l'index unique refuse une seconde commande portant la clé", async () => {
    const first = await checkout.createOrderFromCart('fb-ik-a', dto, 'k-2');
    const { id: _id, ...rest } = await prisma.order.findUniqueOrThrow({
      where: { id: first.data.id },
    });

    await expect(
      prisma.order.create({ data: { ...rest } as never }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('une clé neuve après une commande passe au contrôle habituel du panier', async () => {
    await checkout.createOrderFromCart('fb-ik-a', dto, 'k-3');

    // Le panier est vide : un nouveau geste (autre clé) n'est pas un rejeu.
    await expect(
      checkout.createOrderFromCart('fb-ik-a', dto, 'k-4'),
    ).rejects.toBeDefined();
    expect(await prisma.order.count()).toBe(1);
  });
});
