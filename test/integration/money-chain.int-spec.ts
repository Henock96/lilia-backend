import { PrismaPg } from '@prisma/adapter-pg';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  OrderStatus,
  PaymentEventSource,
  PaymentStatus,
  PayoutStatus,
  PrismaClient,
} from '@prisma/client';

import { PaymentService } from '../../apps/lilia-app/src/modules/payments/services/payment.service';
import { RestaurantPayoutService } from '../../apps/lilia-app/src/modules/payments/services/restaurant-payout.service';
import { PaymentEventService } from '../../apps/lilia-app/src/modules/payments/services/payment-event.service';
import { PayoutStateMachine } from '../../apps/lilia-app/src/modules/payments/payout-state.machine';
import { PlatformSettingsService } from '../../apps/lilia-app/src/modules/platform-settings/platform-settings.service';
import { OutboxService } from '../../apps/lilia-app/src/modules/outbox/outbox.service';

/**
 * **La chaîne de l'argent, de bout en bout.**
 *
 * L'audit du 4 septembre 2026 pose le constat qui rend ce fichier nécessaire :
 *
 * > « Le reversement vendeur et le webhook pawaPay sont écrits, testés
 * > unitairement, et n'ont jamais fonctionné une seule fois en conditions
 * > réelles. Un test unitaire vert sur une machine à états ne prouve pas qu'un
 * > virement arrive sur un téléphone MTN. »
 *
 * Les tests unitaires mockent Prisma ; `payments.int-spec.ts` prouve les
 * contraintes SQL une par une. **Personne ne parcourait la chaîne entière.**
 * Ce fichier suit donc **une seule commande**, sans réinitialiser l'état entre
 * les étapes :
 *
 * ```
 * commande EN_ATTENTE
 *   → encaissement ouvert
 *   → callback prestataire COMPLETED        (source = WEBHOOK)
 *   → commande PAYER, vendeur à prévenir
 *   → commission calculée par le serveur
 *   → reversement créé
 *   → callback prestataire COMPLETED        (source = WEBHOOK)
 *   → reversement SUCCESS
 *   → journal complet et opposable
 * ```
 *
 * ⚠️ **Ce que ce test prouve, et ce qu'il ne prouve pas.** Il exerce les mêmes
 * points de transition que le contrôleur de webhook
 * (`applyCollectionProviderStatus` / `applyPayoutProviderStatus`, avec
 * `source: WEBHOOK`), sur un vrai PostgreSQL. Il ne prouve **pas** que pawaPay
 * appelle réellement notre URL : cela relève de la configuration du tableau de
 * bord prestataire, et le critère de sortie reste une ligne `PaymentEvent`
 * `source='WEBHOOK'` en production.
 *
 * Se saute proprement sans `TEST_DATABASE_URL`.
 */
const DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

describeIfDb(
  'Chaîne de l’argent — encaissement → commande → reversement',
  () => {
    let prisma: PrismaClient;
    let payments: PaymentService;
    let payouts: RestaurantPayoutService;
    let events: PaymentEventService;
    let emitted: { name: string; payload: unknown }[];

    const ORDER_ID = 'mc-order-1';
    const CLIENT_ID = 'mc-client-1';
    const OWNER_ID = 'mc-owner-1';
    const ADMIN_ID = 'mc-admin-1';
    const VENDOR_ID = 'mc-vendor-1';
    const DEPOSIT_REF = 'mc-deposit-0000-0000';
    const SUB_TOTAL = 5000;
    const TOTAL = 6400; // 5000 + 1000 livraison + 400 frais de service

    /**
     * Prestataire simulé. On ne simule **que le réseau** : toutes les décisions
     * (transitions, montants, idempotence) restent celles des vrais services.
     */
    let capturedPayout: { providerPayoutId: string; amountXaf: number } | null;
    const provider = {
      name: 'PAWAPAY',
      createPayout: jest.fn(
        (req: { providerPayoutId: string; amountXaf: number }) => {
          capturedPayout = req;
          // pawaPay accuse réception ; l'issue arrive par callback, plus tard.
          return Promise.resolve({
            accepted: true,
            state: 'PENDING' as const,
            rawStatus: 'ACCEPTED',
          });
        },
      ),
    };
    const registry = {
      currentMode: 'PAWAPAY',
      forPayout: () => provider,
    };

    beforeAll(async () => {
      prisma = new PrismaClient({
        adapter: new PrismaPg({ connectionString: DATABASE_URL }),
      });
      await prisma.$connect();

      const emitter = new EventEmitter2();
      emitted = [];
      emitter.onAny((name, payload) =>
        emitted.push({ name: String(name), payload }),
      );

      events = new PaymentEventService(prisma as never);
      const settings = new PlatformSettingsService(prisma as never);
      const outbox = new OutboxService(prisma as never);
      const config = { get: (_k: string, d?: unknown) => d };

      payments = new PaymentService(
        prisma as never,
        emitter,
        config as never,
        registry as never,
        events,
        outbox,
      );
      payouts = new RestaurantPayoutService(
        prisma as never,
        registry as never,
        settings,
        events,
        new PayoutStateMachine(),
        emitter,
      );

      await prisma.$executeRawUnsafe(`
      TRUNCATE TABLE "PaymentEvent", "restaurant_payouts", "OutboxEvent",
                     "Incident", "DeliveryReview", "DeliveryLocation",
                     "Delivery", "LoyaltyTransaction", "OrderItem",
                     "OrderHistory", "payments", "Refund", "Order",
                     "CartItem", "Cart", "ProductVariant", "Product",
                     "Restaurant", "User", "PlatformSettings"
      RESTART IDENTITY CASCADE
    `);

      await prisma.user.createMany({
        data: [
          { id: CLIENT_ID, firebaseUid: 'fb-mc-c', email: 'mc-c@test.local' },
          {
            id: OWNER_ID,
            firebaseUid: 'fb-mc-o',
            email: 'mc-o@test.local',
            role: 'RESTAURATEUR',
          },
          {
            id: ADMIN_ID,
            firebaseUid: 'fb-mc-a',
            email: 'mc-a@test.local',
            role: 'ADMIN',
          },
        ],
      });

      await prisma.restaurant.create({
        data: {
          id: VENDOR_ID,
          nom: 'Chez Maman Test',
          adresse: 'Poto-Poto',
          phone: '060000001',
          ownerId: OWNER_ID,
          // Le compte de reversement — la case que les six vendeurs de production
          // n'avaient jamais remplie.
          payoutPhoneNumber: '242060000001',
          payoutProvider: 'MTN_MOMO',
          // `null` = taux plateforme. On vérifie plus bas qu'il est bien résolu.
          commissionPercent: null,
        },
      });

      await prisma.order.create({
        data: {
          id: ORDER_ID,
          restaurantId: VENDOR_ID,
          userId: CLIENT_ID,
          subTotal: SUB_TOTAL,
          deliveryFee: 1000,
          serviceFee: 400,
          total: TOTAL,
          paymentMethod: 'MTN_MOMO',
          status: OrderStatus.EN_ATTENTE,
        },
      });
    });

    afterAll(async () => {
      await prisma.$disconnect();
    });

    // ══════════════════════════════════════════════════════════════════════════
    // 1. Encaissement
    // ══════════════════════════════════════════════════════════════════════════

    it('1. la commande naît EN_ATTENTE, sans argent encaissé', async () => {
      const order = await prisma.order.findUniqueOrThrow({
        where: { id: ORDER_ID },
      });
      expect(order.status).toBe(OrderStatus.EN_ATTENTE);
      expect(order.paidAt).toBeNull();
    });

    it('2. une tentative d’encaissement s’ouvre en PENDING', async () => {
      await prisma.payment.create({
        data: {
          id: 'mc-payment-1',
          orderId: ORDER_ID,
          amount: TOTAL,
          currency: 'XAF',
          phoneNumber: '242060000009',
          method: 'MTN_MOMO',
          status: PaymentStatus.PENDING,
          provider: 'PAWAPAY',
          providerTransactionId: DEPOSIT_REF,
        },
      });

      const found = await payments.findByProviderTransactionId(
        'PAWAPAY',
        DEPOSIT_REF,
      );
      expect(found?.id).toBe('mc-payment-1');
    });

    it('3. le callback COMPLETED fait passer la commande à PAYER', async () => {
      // Exactement ce que fait `PawaPayWebhookController.handleDepositCallback`.
      const outcome = await payments.applyCollectionProviderStatus({
        paymentId: 'mc-payment-1',
        status: {
          state: 'SUCCESS',
          rawStatus: 'COMPLETED',
          amountXaf: TOTAL,
          currency: 'XAF',
          providerTransactionId: 'pawa-tx-1',
          raw: { depositId: DEPOSIT_REF, status: 'COMPLETED' },
        },
        source: PaymentEventSource.WEBHOOK,
      });

      expect(outcome).toBe('APPLIED');

      const payment = await prisma.payment.findUniqueOrThrow({
        where: { id: 'mc-payment-1' },
      });
      const order = await prisma.order.findUniqueOrThrow({
        where: { id: ORDER_ID },
      });
      expect(payment.status).toBe(PaymentStatus.SUCCESS);
      expect(order.status).toBe(OrderStatus.PAYER);
      expect(order.paidAt).not.toBeNull();
    });

    it('4. l’obligation de prévenir le vendeur est écrite dans la transaction', async () => {
      // L'outbox, pas le push : une notification perdue ne doit pas faire perdre
      // la commande. C'est la garantie posée par le fix H7 d'août 2026.
      const outbox = await prisma.outboxEvent.findMany({
        where: { aggregateId: ORDER_ID, type: 'order.paid' },
      });
      expect(outbox).toHaveLength(1);
    });

    it('5. le callback est tracé avec sa VRAIE source', async () => {
      // C'est la ligne dont l'audit constate qu'elle n'existe pas en production :
      // `PaymentEvent WHERE source='WEBHOOK'` valait 0 depuis le premier jour.
      const evts = await events.listForPayment('mc-payment-1');
      expect(evts).toHaveLength(1);
      expect(evts[0].source).toBe(PaymentEventSource.WEBHOOK);
      expect(evts[0].rawStatus).toBe('COMPLETED');
      expect(evts[0].outcome).toBe('APPLIED');
    });

    it('6. un rejeu du même callback ne débite pas deux fois', async () => {
      // pawaPay rejoue pendant quinze minutes tant qu'il n'a pas de 200.
      const outcome = await payments.applyCollectionProviderStatus({
        paymentId: 'mc-payment-1',
        status: {
          state: 'SUCCESS',
          rawStatus: 'COMPLETED',
          amountXaf: TOTAL,
          currency: 'XAF',
          raw: { depositId: DEPOSIT_REF, status: 'COMPLETED' },
        },
        source: PaymentEventSource.WEBHOOK,
      });

      expect(outcome).toBe('DUPLICATE');
      const outbox = await prisma.outboxEvent.findMany({
        where: { aggregateId: ORDER_ID, type: 'order.paid' },
      });
      // Toujours une seule : le vendeur n'est pas prévenu deux fois.
      expect(outbox).toHaveLength(1);
    });

    // ══════════════════════════════════════════════════════════════════════════
    // 2. Éligibilité au reversement
    // ══════════════════════════════════════════════════════════════════════════

    it('7. une commande PAYER n’est pas encore reversable — elle doit être PRÊTE', async () => {
      // Ce délai est délibéré : un remboursement client est simple tant que le
      // vendeur n'a pas été payé, et devient une négociation ensuite.
      const eligibility = await payouts.checkEligibility(ORDER_ID);
      expect(eligibility.eligible).toBe(false);
      expect(eligibility.code).toBe('ORDER_NOT_READY');
    });

    it('8. passée à PRET, la commande devient éligible', async () => {
      await prisma.order.update({
        where: { id: ORDER_ID },
        data: { status: OrderStatus.PRET },
      });

      const eligibility = await payouts.checkEligibility(ORDER_ID);
      expect(eligibility.eligible).toBe(true);
    });

    it('9. le décompte est calculé par le SERVEUR, sur le sous-total', async () => {
      const { breakdown } = await payouts.checkEligibility(ORDER_ID);

      // Taux plateforme (10 % par défaut) puisque le vendeur n'en a pas.
      expect(breakdown!.grossAmount).toBe(SUB_TOTAL);
      expect(breakdown!.commissionPercent).toBe(10);
      expect(breakdown!.commissionAmount).toBe(500);
      expect(breakdown!.payoutAmount).toBe(4500);

      // Ni la livraison ni les frais de service n'entrent dans l'assiette : la
      // livraison n'est pas au vendeur, et le frais de service est payé EN PLUS
      // par le client. Les confondre facturerait deux fois la même chose.
      expect(breakdown!.grossAmount).not.toBe(TOTAL);
    });

    // ══════════════════════════════════════════════════════════════════════════
    // 3. Reversement
    // ══════════════════════════════════════════════════════════════════════════

    it('10. l’administrateur déclenche le reversement — rien ne l’a fait à sa place', async () => {
      const result = await payouts.requestPayout({
        orderId: ORDER_ID,
        adminUserId: ADMIN_ID,
      });

      expect(result.payout.amount).toBe(4500);
      expect(provider.createPayout).toHaveBeenCalledTimes(1);
      expect(capturedPayout!.amountXaf).toBe(4500);

      const row = await prisma.restaurantPayout.findUniqueOrThrow({
        where: { orderId: ORDER_ID },
      });
      expect(row.status).toBe(PayoutStatus.PENDING);
      expect(row.phoneNumber).toBe('242060000001');
      expect(row.commissionAmount).toBe(500);
      // Le taux est FIGÉ : le changer demain ne réécrit pas ce reversement.
      expect(row.commissionPercent).toBe(10);
      // L'identifiant prestataire est persisté AVANT l'appel réseau : une reprise
      // rejoue le même, et pawaPay répond `DUPLICATE_IGNORED` au lieu de virer
      // une seconde fois.
      expect(row.providerPayoutId).toBe(capturedPayout!.providerPayoutId);
    });

    it('11. un second clic ne crée pas un second virement', async () => {
      await expect(
        payouts.requestPayout({ orderId: ORDER_ID, adminUserId: ADMIN_ID }),
      ).rejects.toMatchObject({ status: 409 });
      expect(provider.createPayout).toHaveBeenCalledTimes(1);
    });

    it('12. le callback de reversement finalise le virement', async () => {
      const payout = await prisma.restaurantPayout.findUniqueOrThrow({
        where: { orderId: ORDER_ID },
      });

      const outcome = await payouts.applyPayoutProviderStatus({
        payoutId: payout.id,
        status: {
          state: 'SUCCESS',
          rawStatus: 'COMPLETED',
          amountXaf: 4500,
          currency: 'XAF',
          providerTransactionId: 'pawa-payout-tx-1',
          raw: { payoutId: payout.providerPayoutId, status: 'COMPLETED' },
        },
        source: PaymentEventSource.WEBHOOK,
      });

      expect(outcome).toBe('APPLIED');
      const done = await prisma.restaurantPayout.findUniqueOrThrow({
        where: { orderId: ORDER_ID },
      });
      expect(done.status).toBe(PayoutStatus.SUCCESS);
      expect(done.completedAt).not.toBeNull();
    });

    it('13. un rejeu du callback de reversement ne repaie pas', async () => {
      const payout = await prisma.restaurantPayout.findUniqueOrThrow({
        where: { orderId: ORDER_ID },
      });
      const outcome = await payouts.applyPayoutProviderStatus({
        payoutId: payout.id,
        status: {
          state: 'SUCCESS',
          rawStatus: 'COMPLETED',
          amountXaf: 4500,
          currency: 'XAF',
          raw: {},
        },
        source: PaymentEventSource.WEBHOOK,
      });
      expect(outcome).toBe('DUPLICATE');
    });

    it('14. la commande déjà reversée n’est plus éligible', async () => {
      const eligibility = await payouts.checkEligibility(ORDER_ID);
      expect(eligibility.eligible).toBe(false);
      expect(eligibility.code).toBe('PAYOUT_ALREADY_COMPLETED');
    });

    // ══════════════════════════════════════════════════════════════════════════
    // 4. Ce que la chaîne laisse derrière elle
    // ══════════════════════════════════════════════════════════════════════════

    it('15. le journal raconte toute l’histoire, encaissement et reversement', async () => {
      const all = await prisma.paymentEvent.findMany({
        orderBy: { receivedAt: 'asc' },
      });

      // Un journal en écriture seule : c'est lui qui permet, trois semaines plus
      // tard, de répondre à « le client dit avoir payé, qu'avons-nous reçu ? »
      //
      // Cinq lignes, et leur composition dit exactement ce qui s'est passé :
      expect(
        all.map((e) => `${e.kind}/${e.source}/${e.rawStatus}/${e.outcome}`),
      ).toEqual([
        'COLLECTION/WEBHOOK/COMPLETED/APPLIED', // le client a payé
        'COLLECTION/WEBHOOK/COMPLETED/DUPLICATE', // pawaPay a rejoué
        'PAYOUT/INITIATION/ACCEPTED/APPLIED', // nous avons demandé le virement
        'PAYOUT/WEBHOOK/COMPLETED/APPLIED', // le vendeur a été payé
        'PAYOUT/WEBHOOK/COMPLETED/DUPLICATE', // pawaPay a rejoué
      ]);

      // Quatre des cinq viennent du prestataire. En production, ce compte est
      // **zéro** : c'est tout le sujet du blocker P0-3.
      expect(
        all.filter((e) => e.source === PaymentEventSource.WEBHOOK),
      ).toHaveLength(4);
    });

    it('16. bilan comptable : ce que le client a payé se répartit sans reste', async () => {
      const order = await prisma.order.findUniqueOrThrow({
        where: { id: ORDER_ID },
      });
      const payout = await prisma.restaurantPayout.findUniqueOrThrow({
        where: { orderId: ORDER_ID },
      });

      // Client : 6 400 = 5 000 (produits) + 1 000 (livraison) + 400 (service)
      expect(order.total).toBe(
        order.subTotal + order.deliveryFee + order.serviceFee,
      );
      // Vendeur : 4 500 = 5 000 − 500 de commission
      expect(payout.amount).toBe(order.subTotal - payout.commissionAmount);
      // Lilia Food : 400 de frais de service + 500 de commission = 900,
      // moins les frais du prestataire, qui sont SA charge et non celle du
      // vendeur. Aucun franc n'est compté deux fois.
      expect(order.serviceFee + payout.commissionAmount).toBe(900);
    });

    it('17. un reversement réussi existe réellement en base — le critère de sortie P0-1', async () => {
      const success = await prisma.restaurantPayout.count({
        where: { status: PayoutStatus.SUCCESS },
      });
      expect(success).toBe(1);
    });
  },
);
