import { PrismaPg } from '@prisma/adapter-pg';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { OrderStatus, PrismaClient, Role } from '@prisma/client';

import { RefundComposerService } from '../../apps/lilia-app/src/modules/refunds/refund-composer.service';
import { RefundExecutionService } from '../../apps/lilia-app/src/modules/refunds/refund-execution.service';
import { RefundsService } from '../../apps/lilia-app/src/modules/refunds/refunds.service';
import { PaymentEventService } from '../../apps/lilia-app/src/modules/payments/services/payment-event.service';
import { ClaimsService } from '../../apps/lilia-app/src/modules/claims/claims.service';
import { PromoService } from '../../apps/lilia-app/src/modules/promo/promo.service';

/**
 * **F3-06 — remboursements partiels et réclamations (PostgreSQL réel).**
 *
 * Ce qu'aucun mock ne prouve : les index partiels (un remboursement en vol,
 * un remboursement automatique), le verrou de commande qui départage deux
 * remboursements partiels concurrents (R-06.2), l'unicité d'une réclamation
 * ouverte, et l'avoir qui ne sert qu'à son titulaire.
 */
const DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

describeIfDb(
  'Remboursements partiels et réclamations (PostgreSQL réel)',
  () => {
    let prisma: PrismaClient;
    let composer: RefundComposerService;
    let claims: ClaimsService;
    let refunds: RefundsService;
    let promo: PromoService;
    const providerCalls: string[] = [];

    const ADMIN = { id: 'rc-admin', role: Role.ADMIN };
    const OWNER = { id: 'rc-owner', role: Role.RESTAURATEUR };
    const CLIENT = { id: 'rc-client', role: Role.CLIENT };
    const OTHER = { id: 'rc-other', role: Role.CLIENT };
    const VENDOR = 'rc-vendor';
    const ORDER = 'rc-order';

    beforeAll(async () => {
      prisma = new PrismaClient({
        adapter: new PrismaPg({ connectionString: DATABASE_URL }),
      });
      await prisma.$connect();
      const registry = {
        currentMode: 'PAWAPAY',
        forPayout: () => ({
          name: 'PAWAPAY',
          supportsPayout: true,
          createPayout: async (input: { payoutId: string }) => {
            providerCalls.push(input.payoutId);
            return { accepted: true, duplicate: false, raw: {} };
          },
        }),
      };
      const execution = new RefundExecutionService(
        prisma as never,
        registry as never,
        new PaymentEventService(prisma as never),
      );
      composer = new RefundComposerService(
        prisma as never,
        execution,
        new EventEmitter2(),
      );
      claims = new ClaimsService(prisma as never, new EventEmitter2());
      refunds = new RefundsService(prisma as never);
      promo = new PromoService(prisma as never, {} as never);
    });

    afterAll(async () => {
      await prisma.$disconnect();
    });

    beforeEach(async () => {
      providerCalls.length = 0;
      await prisma.$executeRawUnsafe(`
      TRUNCATE TABLE "PaymentEvent", "restaurant_payouts", "IncidentMessage",
                     "Incident", "RefundLine", "Refund", "PromoUsage", "PromoCode",
                     "OrderItem", "OrderHistory", "Delivery", "payments",
                     "OutboxEvent", "Order", "Product", "Restaurant", "User"
      RESTART IDENTITY CASCADE
    `);
      await prisma.user.createMany({
        data: [
          {
            id: ADMIN.id,
            firebaseUid: 'fb-rc-a',
            email: 'rc-a@t.local',
            role: 'ADMIN',
          },
          {
            id: OWNER.id,
            firebaseUid: 'fb-rc-o',
            email: 'rc-o@t.local',
            role: 'RESTAURATEUR',
          },
          { id: CLIENT.id, firebaseUid: 'fb-rc-c', email: 'rc-c@t.local' },
          { id: OTHER.id, firebaseUid: 'fb-rc-x', email: 'rc-x@t.local' },
        ],
      });
      await prisma.restaurant.create({
        data: {
          id: VENDOR,
          nom: 'Chez Réclamation',
          adresse: 'Bacongo',
          phone: '060000040',
          ownerId: OWNER.id,
        },
      });
      await prisma.product.createMany({
        data: [
          {
            id: 'rc-alloco',
            nom: 'Alloco',
            prixOriginal: 1500,
            restaurantId: VENDOR,
          },
          {
            id: 'rc-poulet',
            nom: 'Poulet DG',
            prixOriginal: 2000,
            restaurantId: VENDOR,
          },
        ],
      });
      await prisma.order.create({
        data: {
          id: ORDER,
          restaurantId: VENDOR,
          userId: CLIENT.id,
          subTotal: 5000,
          deliveryFee: 1000,
          serviceFee: 750,
          total: 6750,
          commissionPercent: 10,
          commissionAmount: 500,
          paymentMethod: 'MTN_MOMO',
          status: OrderStatus.LIVRER,
          items: {
            create: [
              {
                id: 'rc-i1',
                productId: 'rc-alloco',
                variant: 'default',
                quantite: 2,
                prix: 1500,
                snapshotPrice: 1500,
              },
              {
                id: 'rc-i2',
                productId: 'rc-poulet',
                variant: 'default',
                quantite: 1,
                prix: 2000,
                snapshotPrice: 2000,
              },
            ],
          },
        },
      });
      await prisma.delivery.create({
        data: { orderId: ORDER, status: 'LIVRER', deliveredAt: new Date() },
      });
      await prisma.payment.create({
        data: {
          orderId: ORDER,
          amount: 6750,
          phoneNumber: '242060000099',
          status: 'SUCCESS',
          provider: 'PAWAPAY',
          method: 'MTN_MOMO',
        },
      });
    });

    const goodwill = (amountXaf: number) => ({
      lines: [{ kind: 'GOODWILL' as const, amountXaf }],
      reasonCode: 'GOODWILL' as const,
      execute: false,
    });

    it('R-06.1 — un seul remboursement en vol : le second est refusé, par la base aussi', async () => {
      await composer.create(ORDER, goodwill(500), ADMIN.id);
      await expect(
        composer.create(ORDER, goodwill(500), ADMIN.id),
      ).rejects.toMatchObject({ response: { code: 'REFUND_IN_FLIGHT' } });

      // L'index partiel, sans le service : un 2ᵉ PENDING est impossible.
      await expect(
        prisma.refund.create({
          data: {
            orderId: ORDER,
            amount: 100,
            reason: 'x',
            reasonCode: 'OTHER',
          },
        }),
      ).rejects.toMatchObject({ code: 'P2002' });

      // Une fois le premier versé, un second remboursement passe.
      await prisma.refund.updateMany({ data: { status: 'COMPLETED' } });
      await composer.create(ORDER, goodwill(300), ADMIN.id);
      expect(await prisma.refund.count({ where: { orderId: ORDER } })).toBe(2);
    });

    it('R-06.2 — deux remboursements partiels concurrents qui dépassent ensemble le total : un seul passe', async () => {
      for (let round = 0; round < 5; round++) {
        await prisma.refundLine.deleteMany();
        await prisma.refund.deleteMany();
        // Un remboursement antérieur versé laisse 6 750 − 3 000 = 3 750.
        await prisma.refund.create({
          data: {
            orderId: ORDER,
            amount: 3000,
            reason: 'antérieur',
            reasonCode: 'OTHER',
            status: 'COMPLETED',
          },
        });
        const results = await Promise.allSettled([
          composer.create(ORDER, goodwill(2500), ADMIN.id),
          composer.create(ORDER, goodwill(2500), ADMIN.id),
        ]);
        expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
        const sum = await prisma.refund.aggregate({
          where: { orderId: ORDER, status: { not: 'REJECTED' } },
          _sum: { amount: true },
        });
        expect(sum._sum.amount).toBeLessThanOrEqual(6750);
      }
    });

    it('R-06.3 — lignes d’articles figées, reliquat par article suivi en base', async () => {
      const r = await composer.create(
        ORDER,
        {
          lines: [{ kind: 'ITEM', orderItemId: 'rc-i1', quantity: 1 }],
          reasonCode: 'MISSING_ITEM',
          execute: false,
        },
        ADMIN.id,
      );
      expect(r).toMatchObject({ amountXaf: 1500, bearer: 'VENDOR' });
      await prisma.refund.updateMany({ data: { status: 'COMPLETED' } });

      const quote = await composer.quote(ORDER, { lines: [] });
      expect(
        quote.refundable.items.find((i) => i.orderItemId === 'rc-i1'),
      ).toMatchObject({
        orderedQty: 2,
        refundedQty: 1,
      });
      await expect(
        composer.create(
          ORDER,
          {
            lines: [{ kind: 'ITEM', orderItemId: 'rc-i1', quantity: 2 }],
            reasonCode: 'MISSING_ITEM',
            execute: false,
          },
          ADMIN.id,
        ),
      ).rejects.toMatchObject({ response: { code: 'REFUND_ITEM_QUANTITY' } });
    });

    it('CHECK — une ligne à montant nul ou mal formée est refusée par la base', async () => {
      const refund = await prisma.refund.create({
        data: {
          orderId: ORDER,
          amount: 100,
          reason: 'x',
          reasonCode: 'OTHER',
          status: 'COMPLETED',
        },
      });
      await expect(
        prisma.refundLine.create({
          data: { refundId: refund.id, kind: 'GOODWILL', amountXaf: 0 },
        }),
      ).rejects.toThrow();
      await expect(
        prisma.refundLine.create({
          data: { refundId: refund.id, kind: 'ITEM', amountXaf: 100 },
        }),
      ).rejects.toThrow();
    });

    it('R-06.5 — remboursement vendeur refusé une fois le vendeur payé ; geste Lilia accepté et viré', async () => {
      await prisma.restaurantPayout.create({
        data: {
          orderId: ORDER,
          restaurantId: VENDOR,
          grossAmount: 5000,
          commissionPercent: 10,
          commissionAmount: 500,
          amount: 4500,
          phoneNumber: '242060000040',
          providerCode: 'MTN_MOMO',
          status: 'SUCCESS',
          requestedBy: ADMIN.id,
        },
      });
      await expect(
        composer.create(
          ORDER,
          {
            lines: [{ kind: 'ITEM', orderItemId: 'rc-i2', quantity: 1 }],
            reasonCode: 'DAMAGED',
            execute: false,
          },
          ADMIN.id,
        ),
      ).rejects.toMatchObject({ response: { code: 'VENDOR_ALREADY_PAID' } });

      const ok = await composer.create(
        ORDER,
        { ...goodwill(700), execute: true },
        ADMIN.id,
      );
      expect(ok.execution.executed).toBe(true);
      expect(providerCalls).toHaveLength(1);
    });

    it('annulation rejouée après un remboursement versé : pas de second remboursement', async () => {
      await prisma.order.update({
        where: { id: ORDER },
        data: { status: 'ANNULER' },
      });
      const first = await refunds.openForCancelledOrder({
        orderId: ORDER,
        reason: 'Annulation',
      });
      await prisma.refund.update({
        where: { id: first!.id },
        data: { status: 'COMPLETED' },
      });
      const replay = await refunds.openForCancelledOrder({
        orderId: ORDER,
        reason: 'Annulation',
      });
      expect(replay?.id).toBe(first!.id);
      expect(await prisma.refund.count()).toBe(1);
    });

    describe('réclamations', () => {
      const claim = () =>
        claims.open(ORDER, CLIENT, {
          reason: 'MISSING_ITEM',
          items: [{ orderItemId: 'rc-i1', quantity: 1 }],
          note: 'Il manquait un alloco.',
        });

      it('R-06.7 — une seule réclamation ouverte par commande, même en concurrence', async () => {
        const results = await Promise.allSettled([claim(), claim(), claim()]);
        expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
        const rejected = results.find(
          (r) => r.status === 'rejected',
        ) as PromiseRejectedResult;
        expect(rejected.reason.response).toMatchObject({
          code: 'CLAIM_ALREADY_OPEN',
        });
        expect(await prisma.incident.count()).toBe(1);
      });

      it('D4 — au-delà de 24 h après la livraison : refusée', async () => {
        await prisma.delivery.update({
          where: { orderId: ORDER },
          data: { deliveredAt: new Date(Date.now() - 25 * 3_600_000) },
        });
        await expect(claim()).rejects.toMatchObject({
          response: { code: 'CLAIM_WINDOW_CLOSED' },
        });
      });

      it('404 uniforme : la commande d’un autre, la réclamation d’un autre', async () => {
        await expect(
          claims.open(ORDER, OTHER, { reason: 'LATE' }),
        ).rejects.toThrow('Commande introuvable.');
        const { data } = await claim();
        await expect(claims.findOne(data.id, OTHER)).rejects.toThrow(
          'Demande introuvable.',
        );
      });

      it('fil : le vendeur écrit au support seul ; le client ne voit jamais STAFF_ONLY', async () => {
        const { data } = await claim();
        await claims.postMessage(data.id, OWNER, {
          body: 'Le deuxième alloco était dans le sac.',
          visibility: 'ALL', // ignoré : imposé STAFF_ONLY
        });
        const forClient = await claims.findOne(data.id, CLIENT);
        expect(forClient.data.messages).toHaveLength(1);
        expect(forClient.data).not.toHaveProperty('vendorImpactXaf');
        const forVendor = await claims.findOne(data.id, OWNER);
        expect(forVendor.data.messages.map((m) => m.visibility)).toEqual([
          'ALL',
          'STAFF_ONLY',
        ]);
      });

      it('remboursement lié : la réclamation se clôt, le client lit l’issue, le vendeur son impact', async () => {
        const { data } = await claim();
        await composer.create(
          ORDER,
          {
            lines: [{ kind: 'ITEM', orderItemId: 'rc-i1', quantity: 1 }],
            reasonCode: 'MISSING_ITEM',
            incidentId: data.id,
            execute: false,
          },
          ADMIN.id,
        );
        const forClient = await claims.findOne(data.id, CLIENT);
        expect(forClient.data).toMatchObject({
          status: 'RESOLVED',
          outcome: 'REFUNDED',
        });
        expect(
          forClient.data.messages[forClient.data.messages.length - 1]
            ?.authorLabel,
        ).toBe('Service client Lilia');
        const forVendor = await claims.findOne(data.id, OWNER);
        expect(forVendor.data.vendorImpactXaf).toBe(1500);
        // La réclamation close, une nouvelle peut s'ouvrir (l'index est partiel).
        await expect(claim()).resolves.toBeDefined();
      });

      it('R-06.6 — l’avoir ne sert qu’à son titulaire', async () => {
        const { data } = await claim();
        const { data: voucher } = await claims.issueVoucher(data.id, ADMIN, {
          amountXaf: 1000,
        });
        expect(voucher.code).toMatch(/^AVOIR-[A-Z2-9]{8}$/);
        await expect(
          promo.validateCode(voucher.code, OTHER.id, VENDOR, 5000, 1000),
        ).rejects.toThrow(/invalide ou introuvable/);
        await expect(
          promo.validateCode(voucher.code, CLIENT.id, VENDOR, 5000, 1000),
        ).resolves.toBeDefined();
        const abuse = await claims.abuseScore(CLIENT.id);
        expect(abuse).toMatchObject({ claims30d: 1, accepted30d: 1 });
      });
    });
  },
);
