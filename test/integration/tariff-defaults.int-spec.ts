import { PrismaPg } from '@prisma/adapter-pg';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaClient } from '@prisma/client';

import { OrderCheckoutService } from '../../apps/lilia-app/src/modules/orders/order-checkout.service';
import { OrderValidatorService } from '../../apps/lilia-app/src/modules/orders/order-validator.service';
import { OrderCalculatorService } from '../../apps/lilia-app/src/modules/orders/order-calculator.service';
import { StockService } from '../../apps/lilia-app/src/modules/orders/stock.service';
import { PreorderValidatorService } from '../../apps/lilia-app/src/modules/vendors/preorder-validator.service';

/**
 * Politique tarifaire du 29/10/2026 — 15 % de frais de service client, 0 % de
 * commission vendeur — sur PostgreSQL réel, migration
 * `platform_settings_tariff_defaults` appliquée.
 *
 * Trois garanties :
 *  1. un environnement NEUF s'initialise à 15 % / 0 % ;
 *  2. une ligne DÉJÀ enregistrée n'est pas réécrite par le défaut ;
 *  3. une commande passée sur les réglages par défaut porte 15 % de frais
 *     et 0 % de commission — aucun reliquat du défaut historique de 10 %.
 */
const DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

describeIfDb('Réglages tarifaires par défaut (PostgreSQL réel)', () => {
  let prisma: PrismaClient;

  beforeAll(async () => {
    prisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: DATABASE_URL }),
    });
    await prisma.$connect();
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(`DELETE FROM "PlatformSettings"`);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  /** Ce que fait `PlatformSettingsService` au premier démarrage. */
  const readFresh = () =>
    prisma.platformSettings.upsert({
      where: { id: 'singleton' },
      create: { id: 'singleton' },
      update: {},
    });

  it('environnement neuf : 15 % de frais de service, 0 % de commission', async () => {
    const s = await readFresh();
    expect(s.serviceFeePercent).toBe(15);
    expect(s.restaurantCommissionPercent).toBe(0);
    // Le taux épicerie reste séparé : non posé, il ne change rien.
    expect(s.groceryServiceFeeBps).toBeNull();
  });

  it('une ligne déjà enregistrée garde ses valeurs (le défaut ne réécrit rien)', async () => {
    await prisma.platformSettings.create({
      data: {
        id: 'singleton',
        serviceFeePercent: 8,
        restaurantCommissionPercent: 10,
      },
    });
    const s = await readFresh();
    expect(s.serviceFeePercent).toBe(8);
    expect(s.restaurantCommissionPercent).toBe(10);
  });

  it('une commande passée sur les réglages par défaut : 15 % de frais, 0 % de commission', async () => {
    const settings = await readFresh();
    await prisma.$executeRawUnsafe(`
      TRUNCATE TABLE "User", "Restaurant", "Product", "Cart", "Order"
      RESTART IDENTITY CASCADE
    `);
    await prisma.user.create({
      data: {
        id: 'td-o',
        firebaseUid: 'fb-td-o',
        email: 'td-o@t.local',
        role: 'RESTAURATEUR',
      },
    });
    await prisma.restaurant.create({
      data: {
        id: 'td-v',
        nom: 'Chez Tarif',
        adresse: 'Moungali',
        phone: '060000091',
        ownerId: 'td-o',
        adminApproved: true,
        isActive: true,
        onboardingStatus: 'ACTIVATED',
        supportsPickup: true,
        commissionPercent: null, // pas de taux propre : la plateforme décide
      },
    });
    await prisma.product.create({
      data: {
        id: 'td-p',
        nom: 'Poulet',
        prixOriginal: 3000,
        restaurantId: 'td-v',
        stockPolicy: 'UNLIMITED',
        variants: { create: { id: 'td-vp', prix: 3000 } },
      },
    });
    await prisma.user.create({
      data: { id: 'td-c', firebaseUid: 'fb-td-c', email: 'td-c@t.local' },
    });
    await prisma.cart.create({
      data: {
        userId: 'td-c',
        items: {
          create: { productId: 'td-p', variantId: 'td-vp', quantite: 1 },
        },
      },
    });

    const checkout = new OrderCheckoutService(
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
      // Les réglages RÉELLEMENT enregistrés, pas des valeurs de test.
      { getSettings: async () => settings } as never,
      new PreorderValidatorService(prisma as never),
      {} as never,
      { resolveForAddress: async () => null } as never,
      {} as never,
      { recordCreation: async () => undefined } as never,
      { announce: async () => undefined } as never,
      { resolveForCart: async () => null } as never,
    );

    const created = (await checkout.createOrderFromCart(
      'fb-td-c',
      { paymentMethod: 'MTN_MOMO', isDelivery: false } as never,
      `td-${Date.now()}`,
    )) as { data?: { id: string } } | { id: string };
    const id =
      'data' in created && created.data
        ? created.data.id
        : (created as { id: string }).id;
    const order = await prisma.order.findUniqueOrThrow({ where: { id } });

    expect(order.subTotal).toBe(3000);
    expect(order.serviceFee).toBe(450); // 15 % de 3 000
    expect(order.commissionPercent).toBe(0);
    expect(order.commissionAmount).toBe(0);
  });
});
