import { PrismaPg } from '@prisma/adapter-pg';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaClient } from '@prisma/client';

import { OrderCheckoutService } from '../../apps/lilia-app/src/modules/orders/order-checkout.service';
import { OrderValidatorService } from '../../apps/lilia-app/src/modules/orders/order-validator.service';
import { OrderCalculatorService } from '../../apps/lilia-app/src/modules/orders/order-calculator.service';
import { StockService } from '../../apps/lilia-app/src/modules/orders/stock.service';
import { PreorderValidatorService } from '../../apps/lilia-app/src/modules/vendors/preorder-validator.service';

/**
 * Checkouts simultanés **du même produit**, par des clients différents — le
 * cas le plus banal d'une heure de pointe, jamais testé de bout en bout.
 *
 * Régression F3-10 (mesurée le 26/09/2026) : la réservation verrouillait les
 * produits en `FOR UPDATE` APRÈS l'insertion des `OrderItem`, dont la clé
 * étrangère pose un verrou `KEY SHARE` sur le produit. Les deux verrous sont
 * incompatibles : deux checkouts s'attendaient mutuellement, PostgreSQL en
 * tuait un (`deadlock detected`). 1 commande sur 2 échouait dès deux clients,
 * 0 sur 20 à vingt. `FOR NO KEY UPDATE` sérialise toujours les checkouts
 * entre eux sans heurter les verrous de clé.
 *
 * Les tests de stock existants attaquaient `StockService` seul, sans la
 * création de commande qui précède : ils ne pouvaient pas voir l'interblocage.
 */
const DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

describeIfDb(
  'Checkout — même produit, 20 clients simultanés (PostgreSQL réel)',
  () => {
    let prisma: PrismaClient;
    let checkout: OrderCheckoutService;
    const N = 20;

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
        { get: () => undefined } as never, // Redis désactivé
        settings as never,
        new PreorderValidatorService(prisma as never),
        {} as never, // quartiers — retrait
        {} as never, // destination — retrait
        {} as never, // tarification — mode historique
        { recordCreation: async () => undefined } as never,
        { announce: async () => undefined } as never,
      );
    });

    afterAll(async () => {
      await prisma.$disconnect();
    });

    async function seed(stock: {
      policy: 'UNLIMITED' | 'INVENTORY';
      left: number | null;
    }) {
      await prisma.$executeRawUnsafe(`
      TRUNCATE TABLE "User", "Restaurant", "Product", "Cart", "Order"
      RESTART IDENTITY CASCADE
    `);
      await prisma.user.create({
        data: {
          id: 'sp-o',
          firebaseUid: 'fb-sp-o',
          email: 'sp-o@t.local',
          role: 'RESTAURATEUR',
        },
      });
      await prisma.restaurant.create({
        data: {
          id: 'sp-v',
          nom: 'Chez Pointe',
          adresse: 'Moungali',
          phone: '060000072',
          ownerId: 'sp-o',
          adminApproved: true,
          isActive: true,
          onboardingStatus: 'ACTIVATED',
        },
      });
      await prisma.product.create({
        data: {
          id: 'sp-p',
          nom: 'Poulet',
          prixOriginal: 3000,
          restaurantId: 'sp-v',
          stockPolicy: stock.policy,
          stockRestant: stock.left,
          variants: { create: { id: 'sp-vp', prix: 3000 } },
        },
      });
      for (let i = 0; i < N; i++) {
        await prisma.user.create({
          data: {
            id: `sp-c${i}`,
            firebaseUid: `fb-sp-c${i}`,
            email: `sp-c${i}@t.local`,
          },
        });
        await prisma.cart.create({
          data: {
            userId: `sp-c${i}`,
            items: {
              create: { productId: 'sp-p', variantId: 'sp-vp', quantite: 1 },
            },
          },
        });
      }
    }

    const rush = () =>
      Promise.all(
        Array.from({ length: N }, (_, i) =>
          checkout
            .createOrderFromCart(
              `fb-sp-c${i}`,
              { paymentMethod: 'MTN_MOMO', isDelivery: false } as never,
              `sp-key-${i}`,
            )
            .then(
              () => 'OK',
              (err: { response?: { code?: string }; message?: string }) =>
                err.response?.code ??
                (String(err.message).includes('deadlock')
                  ? 'DEADLOCK'
                  : 'ERROR'),
            ),
        ),
      );

    it('produit illimité : les 20 commandes passent, aucun interblocage', async () => {
      await seed({ policy: 'UNLIMITED', left: null });
      const results = await rush();
      expect(results).toEqual(Array(N).fill('OK'));
      expect(await prisma.order.count()).toBe(N);
    });

    it('stock de 5 : exactement 5 commandes, les autres en rupture, jamais d’interblocage', async () => {
      await seed({ policy: 'INVENTORY', left: 5 });
      const results = await rush();
      expect(results.filter((r) => r === 'OK')).toHaveLength(5);
      expect(
        results.filter((r) => r !== 'OK').every((r) => r === 'OUT_OF_STOCK'),
      ).toBe(true);
      const product = await prisma.product.findUniqueOrThrow({
        where: { id: 'sp-p' },
      });
      expect(product.stockRestant).toBe(0);
    });
  },
);
