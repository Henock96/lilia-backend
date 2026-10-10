import { PrismaPg } from '@prisma/adapter-pg';
import { ConflictException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { OnboardingStatus, OrderStatus, PrismaClient } from '@prisma/client';

import { PaymentService } from '../../apps/lilia-app/src/modules/payments/services/payment.service';
import { PaymentEventService } from '../../apps/lilia-app/src/modules/payments/services/payment-event.service';
import { OrderTransitionService } from '../../apps/lilia-app/src/modules/orders/order-transition.service';
import { OutboxService } from '../../apps/lilia-app/src/modules/outbox/outbox.service';

/**
 * Décision D-3 (10/10/2026), sur un **vrai PostgreSQL** : un article passé
 * indisponible entre le checkout et le paiement n'est jamais débité.
 *
 * Seul le réseau du prestataire est simulé ; la lecture des articles, le
 * refus et l'absence d'écriture sont ceux du vrai service.
 */
const DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

describeIfDb(
  'Paiement — aucun article en rupture ne se paie (PostgreSQL réel)',
  () => {
    let prisma: PrismaClient;
    let payments: PaymentService;

    const provider = {
      name: 'PAWAPAY',
      supportsCollection: true,
      supportsPayout: true,
      createCollection: jest.fn(),
    };

    beforeAll(async () => {
      prisma = new PrismaClient({
        adapter: new PrismaPg({ connectionString: DATABASE_URL }),
      });
      await prisma.$connect();
      payments = new PaymentService(
        prisma as never,
        new EventEmitter2(),
        { get: (_k: string, d?: unknown) => d } as never,
        {
          currentMode: 'PAWAPAY',
          forNewTransaction: () => provider,
          forStoredProvider: () => provider,
        } as never,
        new PaymentEventService(prisma as never),
        new OutboxService(prisma as never),
        new OrderTransitionService(),
      );
    });

    afterAll(async () => {
      await prisma.$disconnect();
    });

    beforeEach(async () => {
      provider.createCollection.mockReset().mockResolvedValue({
        accepted: true,
        duplicate: false,
        raw: {},
      });
      await prisma.$executeRawUnsafe(
        `TRUNCATE TABLE "User", "Restaurant", "Product" RESTART IDENTITY CASCADE`,
      );
      await prisma.user.create({
        data: {
          id: 'pr-client',
          firebaseUid: 'fb-pr-client',
          email: 'c@test.local',
        },
      });
      await prisma.user.create({
        data: {
          id: 'pr-owner',
          firebaseUid: 'fb-pr-owner',
          email: 'o@test.local',
          role: 'RESTAURATEUR',
        },
      });
      await prisma.restaurant.create({
        data: {
          id: 'pr-resto',
          nom: 'Chez Mère Lili',
          adresse: 'Bacongo',
          phone: '060000000',
          ownerId: 'pr-owner',
          onboardingStatus: OnboardingStatus.ACTIVATED,
          adminApproved: true,
        },
      });
      for (const id of ['poulet', 'alloco']) {
        await prisma.product.create({
          data: {
            id,
            nom: id === 'poulet' ? 'Poulet braisé' : 'Alloco',
            prixOriginal: 2500,
            restaurantId: 'pr-resto',
            variants: {
              create: [{ id: `${id}-v`, label: 'Standard', prix: 2500 }],
            },
          },
        });
      }
      // Commande passée au checkout : EN_ATTENTE, deux lignes.
      await prisma.order.create({
        data: {
          id: 'pr-order',
          userId: 'pr-client',
          restaurantId: 'pr-resto',
          subTotal: 5000,
          deliveryFee: 1000,
          serviceFee: 750,
          total: 6750,
          paymentMethod: 'MTN_MOMO',
          status: OrderStatus.EN_ATTENTE,
          items: {
            create: [
              {
                productId: 'poulet',
                variant: 'Standard',
                variantId: 'poulet-v',
                quantite: 1,
                prix: 2500,
              },
              {
                productId: 'alloco',
                variant: 'Standard',
                variantId: 'alloco-v',
                quantite: 1,
                prix: 2500,
              },
            ],
          },
        },
      });
    });

    const pay = () =>
      payments.createPayment(
        { orderId: 'pr-order', phoneNumber: '061234567' } as never,
        'fb-pr-client',
        'provider',
      );

    it('articles toujours disponibles : la demande part chez le prestataire', async () => {
      await pay();
      expect(provider.createCollection).toHaveBeenCalledTimes(1);
      expect(
        await prisma.payment.count({ where: { orderId: 'pr-order' } }),
      ).toBe(1);
    });

    it('un plat marqué indisponible après le checkout : 409, aucun débit, aucune ligne de paiement, commande intacte', async () => {
      await prisma.product.update({
        where: { id: 'alloco' },
        data: { isAvailable: false },
      });

      const error = await pay().then(
        () => null,
        (e: unknown) => e,
      );

      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).getResponse()).toMatchObject({
        code: 'ORDER_ITEMS_UNAVAILABLE',
        unavailableItems: ['Alloco'],
      });
      expect(provider.createCollection).not.toHaveBeenCalled();
      expect(
        await prisma.payment.count({ where: { orderId: 'pr-order' } }),
      ).toBe(0);
      const order = await prisma.order.findUniqueOrThrow({
        where: { id: 'pr-order' },
      });
      expect(order.status).toBe(OrderStatus.EN_ATTENTE);
    });

    it('un plat retiré du catalogue après le checkout : 409', async () => {
      await prisma.product.update({
        where: { id: 'poulet' },
        data: { deletedAt: new Date() },
      });
      await expect(pay()).rejects.toThrow(ConflictException);
      expect(provider.createCollection).not.toHaveBeenCalled();
    });
  },
);
