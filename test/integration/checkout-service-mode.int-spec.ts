import { PrismaPg } from '@prisma/adapter-pg';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaClient } from '@prisma/client';

import { OrderCheckoutService } from '../../apps/lilia-app/src/modules/orders/order-checkout.service';
import { OrderValidatorService } from '../../apps/lilia-app/src/modules/orders/order-validator.service';
import { OrderCalculatorService } from '../../apps/lilia-app/src/modules/orders/order-calculator.service';
import { StockService } from '../../apps/lilia-app/src/modules/orders/stock.service';
import { PreorderValidatorService } from '../../apps/lilia-app/src/modules/vendors/preorder-validator.service';

/**
 * Mode de service (Lot 1) — de la colonne `Restaurant.supports*` à la
 * commande, sans mock de Prisma.
 *
 * Ce que les tests unitaires ne montrent pas : que le checkout relit bien la
 * configuration **en base au moment du paiement**. Le dernier cas modifie le
 * vendeur entre la composition du panier et le checkout — exactement la
 * situation d'un client qui a vu « Retrait » la veille.
 */
const DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

describeIfDb('Checkout — modes de service (PostgreSQL réel)', () => {
  let prisma: PrismaClient;
  let checkout: OrderCheckoutService;
  let attempt = 0;

  beforeAll(async () => {
    prisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: DATABASE_URL }),
    });
    await prisma.$connect();
    const settings = {
      getSettings: async () => ({
        modifiersEnabled: false,
        serviceFeePercent: 15,
        restaurantCommissionPercent: 10,
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
      {} as never, // quartiers — prix FIXED, jamais sollicité
      {
        // Destination résolue sans quartier : le prix FIXED suffit.
        resolveForAddress: async () => ({
          address: 'Rue 1, Moungali',
          latitude: null,
          longitude: null,
          precision: 'UNKNOWN',
          quartierId: null,
          quartierNom: null,
          landmark: null,
        }),
      } as never,
      {} as never, // tarification — mode historique
      { recordCreation: async () => undefined } as never,
      { announce: async () => undefined } as never,
      { resolveForCart: async () => null } as never, // offres (F3-11)
    );
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function seed(modes: {
    supportsDelivery: boolean;
    supportsPickup: boolean;
  }) {
    await prisma.$executeRawUnsafe(`
      TRUNCATE TABLE "User", "Restaurant", "Product", "Cart", "Order"
      RESTART IDENTITY CASCADE
    `);
    await prisma.user.create({
      data: {
        id: 'sm-o',
        firebaseUid: 'fb-sm-o',
        email: 'sm-o@t.local',
        role: 'RESTAURATEUR',
      },
    });
    await prisma.restaurant.create({
      data: {
        id: 'sm-v',
        nom: 'Chez Mode',
        adresse: 'Moungali',
        phone: '060000081',
        ownerId: 'sm-o',
        adminApproved: true,
        isActive: true,
        onboardingStatus: 'ACTIVATED',
        ...modes,
      },
    });
    await prisma.product.create({
      data: {
        id: 'sm-p',
        nom: 'Poulet',
        prixOriginal: 3000,
        restaurantId: 'sm-v',
        stockPolicy: 'UNLIMITED',
        variants: { create: { id: 'sm-vp', prix: 3000 } },
      },
    });
    await prisma.user.create({
      data: { id: 'sm-c', firebaseUid: 'fb-sm-c', email: 'sm-c@t.local' },
    });
    await prisma.cart.create({
      data: {
        userId: 'sm-c',
        items: {
          create: { productId: 'sm-p', variantId: 'sm-vp', quantite: 1 },
        },
      },
    });
  }

  const dto = (isDelivery: boolean) =>
    ({
      paymentMethod: 'MTN_MOMO',
      isDelivery,
      ...(isDelivery ? { adresseId: 'sm-a' } : {}),
    }) as never;

  /** `OK`, ou le code d'erreur structuré du refus. */
  const order = (isDelivery: boolean) =>
    checkout
      .createOrderFromCart('fb-sm-c', dto(isDelivery), `sm-key-${++attempt}`)
      .then(
        () => 'OK',
        (err: { response?: { code?: string }; message?: string }) =>
          err.response?.code ?? `ERROR: ${err.message}`,
      );

  const quote = (isDelivery: boolean) =>
    checkout.quote('fb-sm-c', dto(isDelivery)).then(
      () => 'OK',
      (err: { response?: { code?: string }; message?: string }) =>
        err.response?.code ?? `ERROR: ${err.message}`,
    );

  it('livraison seulement : le retrait est refusé, la livraison passe', async () => {
    await seed({ supportsDelivery: true, supportsPickup: false });
    expect(await quote(false)).toBe('PICKUP_UNAVAILABLE');
    expect(await order(false)).toBe('PICKUP_UNAVAILABLE');
    expect(await prisma.order.count()).toBe(0);

    expect(await order(true)).toBe('OK');
    const created = await prisma.order.findFirstOrThrow();
    expect(created.isDelivery).toBe(true);
  });

  it('retrait seulement : la livraison est refusée, le retrait passe', async () => {
    await seed({ supportsDelivery: false, supportsPickup: true });
    expect(await quote(true)).toBe('DELIVERY_UNAVAILABLE');
    expect(await order(true)).toBe('DELIVERY_UNAVAILABLE');
    expect(await prisma.order.count()).toBe(0);

    expect(await order(false)).toBe('OK');
    const created = await prisma.order.findFirstOrThrow();
    expect(created.isDelivery).toBe(false);
    expect(created.deliveryFee).toBe(0);
  });

  it('les deux modes : comportement historique inchangé', async () => {
    await seed({ supportsDelivery: true, supportsPickup: true });
    expect(await quote(true)).toBe('OK');
    expect(await quote(false)).toBe('OK');
    expect(await order(false)).toBe('OK');
    expect(await prisma.order.count()).toBe(1);
  });

  it('vendeur modifié après la composition du panier : la configuration ACTUELLE tranche', async () => {
    await seed({ supportsDelivery: true, supportsPickup: true });
    expect(await quote(false)).toBe('OK'); // ce que le client a vu

    await prisma.restaurant.update({
      where: { id: 'sm-v' },
      data: { supportsPickup: false },
    });

    expect(await order(false)).toBe('PICKUP_UNAVAILABLE');
    expect(await prisma.order.count()).toBe(0);
    // Le panier n'est pas consommé : le client peut changer de mode.
    expect(await prisma.cartItem.count()).toBe(1);
  });
});
