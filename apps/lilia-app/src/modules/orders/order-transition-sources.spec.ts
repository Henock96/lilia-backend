import { EventEmitter2 } from '@nestjs/event-emitter';
import { PaymentEventSource } from '@prisma/client';

import { OrderLifecycleService } from './order-lifecycle.service';
import { OrderStateMachine } from './order-state.machine';
import { OrderTransitionService } from './order-transition.service';
import { PaymentService } from '../payments/services/payment.service';

/**
 * Qui a fait quoi, et depuis où (P0-4).
 *
 * `actionId` portait déjà un rôle avant ce chantier, mais la table était vide :
 * personne n'avait jamais vérifié qu'il était **juste**. Et `source` n'existait
 * pas, alors que c'est elle qui distingue une transition humaine d'un
 * automatisme — donc elle qui rendra calculable le taux d'acceptation vendeur.
 *
 * Ces tests parcourent les chemins réels, pas le service isolé : c'est la
 * traduction au point d'appel qui peut être fausse, pas l'écriture.
 */
describe('Acteur et provenance des transitions', () => {
  /** Dernière ligne d'historique écrite, quel que soit le chemin. */
  let history: Record<string, unknown>[];
  let tx: Record<string, unknown>;

  const captureHistory = () => ({
    create: jest.fn((args: { data: Record<string, unknown> }) => {
      history.push(args.data);
      return Promise.resolve({});
    }),
  });

  beforeEach(() => {
    history = [];
  });

  describe('annulation par le vendeur — acteur, identifiant, provenance, motif', () => {
    it('trace RESTAURATEUR / APP avec son User.id', async () => {
      const order = {
        id: 'o1',
        userId: 'u-client',
        restaurantId: 'r1',
        status: 'PAYER',
        isDelivery: true,
        items: [],
        restaurant: { nom: 'Chez Lili', ownerId: 'u-vendeur' },
      };

      tx = {
        order: {
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          findUniqueOrThrow: jest.fn().mockResolvedValue(order),
        },
        orderHistory: captureHistory(),
        // Aucune ligne de réglages : acceptation vendeur non mise en service.
        platformSettings: { findUnique: jest.fn().mockResolvedValue(null) },
        loyaltyTransaction: {
          aggregate: jest.fn().mockResolvedValue({ _sum: { points: 0 } }),
          create: jest.fn(),
        },
        promoUsage: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
        // F3-11 — aucune offre boutique consommée.
        vendorOfferRedemption: {
          findUnique: jest.fn().mockResolvedValue(null),
        },
        restaurantPayout: { findUnique: jest.fn().mockResolvedValue(null) },
        user: { update: jest.fn() },
      };

      const prisma = {
        user: jest.fn(),
        order: { findUnique: jest.fn().mockResolvedValue(order) },
        delivery: { findFirst: jest.fn().mockResolvedValue(null) },
        $transaction: jest.fn((fn: (t: unknown) => unknown) => fn(tx)),
      } as unknown as Record<string, unknown>;
      (prisma as { user: unknown }).user = {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: 'u-vendeur', role: 'RESTAURATEUR' }),
      };

      const service = new OrderLifecycleService(
        prisma as never,
        new EventEmitter2(),
        new OrderStateMachine(),
        new OrderTransitionService(),
        { restoreInTransaction: jest.fn() } as never,
        { awardForDeliveredOrder: jest.fn() } as never,
        { rewardForDeliveredOrder: jest.fn() } as never,
        { openForCancelledOrder: jest.fn().mockResolvedValue(null) } as never,
        { record: jest.fn() } as never, // AdminAuditService (F-07)
        { enqueueInTransaction: jest.fn() } as never, // OutboxService (lot 4),
        { announce: async () => undefined } as never, // StockSignalService (F3-10)
      );

      await service.updateOrderStatusByRestaurateur(
        'o1',
        'fb-vendeur',
        'ANNULER',
      );

      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({
        fromStatus: 'PAYER',
        toStatus: 'ANNULER',
        actionId: 'RESTAURATEUR',
        actorUserId: 'u-vendeur',
        source: 'APP',
      });
    });

    it('un ADMIN est tracé comme agissant depuis le back-office', async () => {
      const order = {
        id: 'o1',
        userId: 'u-client',
        restaurantId: 'r1',
        status: 'PAYER',
        isDelivery: true,
        items: [],
        restaurant: { nom: 'Chez Lili', ownerId: 'u-vendeur' },
      };

      tx = {
        order: {
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          findUniqueOrThrow: jest.fn().mockResolvedValue(order),
        },
        orderHistory: captureHistory(),
        // Aucune ligne de réglages : acceptation vendeur non mise en service.
        platformSettings: { findUnique: jest.fn().mockResolvedValue(null) },
        loyaltyTransaction: {
          aggregate: jest.fn().mockResolvedValue({ _sum: { points: 0 } }),
          create: jest.fn(),
        },
        promoUsage: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
        // F3-11 — aucune offre boutique consommée.
        vendorOfferRedemption: {
          findUnique: jest.fn().mockResolvedValue(null),
        },
        restaurantPayout: { findUnique: jest.fn().mockResolvedValue(null) },
        user: { update: jest.fn() },
      };

      const prisma = {
        user: {
          findUnique: jest
            .fn()
            .mockResolvedValue({ id: 'u-admin', role: 'ADMIN' }),
        },
        order: { findUnique: jest.fn().mockResolvedValue(order) },
        delivery: { findFirst: jest.fn().mockResolvedValue(null) },
        $transaction: jest.fn((fn: (t: unknown) => unknown) => fn(tx)),
      };

      const service = new OrderLifecycleService(
        prisma as never,
        new EventEmitter2(),
        new OrderStateMachine(),
        new OrderTransitionService(),
        { restoreInTransaction: jest.fn() } as never,
        { awardForDeliveredOrder: jest.fn() } as never,
        { rewardForDeliveredOrder: jest.fn() } as never,
        { openForCancelledOrder: jest.fn().mockResolvedValue(null) } as never,
        { record: jest.fn() } as never, // AdminAuditService (F-07)
        { enqueueInTransaction: jest.fn() } as never, // OutboxService (lot 4),
        { announce: async () => undefined } as never, // StockSignalService (F3-10)
      );

      await service.updateOrderStatusByRestaurateur(
        'o1',
        'fb-admin',
        'ANNULER',
      );

      expect(history[0]).toMatchObject({
        actionId: 'ADMIN',
        actorUserId: 'u-admin',
        source: 'ADMIN_APP',
      });
    });
  });

  describe('expiration par le cron', () => {
    it('trace SYSTEM / CRON, sans auteur, avec le motif', async () => {
      const order = {
        id: 'o1',
        userId: 'u-client',
        restaurantId: 'r1',
        status: 'EN_ATTENTE',
        items: [],
      };

      tx = {
        order: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
        orderHistory: captureHistory(),
        // Aucune ligne de réglages : acceptation vendeur non mise en service.
        platformSettings: { findUnique: jest.fn().mockResolvedValue(null) },
        loyaltyTransaction: {
          aggregate: jest.fn().mockResolvedValue({ _sum: { points: 0 } }),
          create: jest.fn(),
        },
        promoUsage: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
        // F3-11 — aucune offre boutique consommée.
        vendorOfferRedemption: {
          findUnique: jest.fn().mockResolvedValue(null),
        },
        restaurantPayout: { findUnique: jest.fn().mockResolvedValue(null) },
        payment: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
        user: { update: jest.fn() },
      };

      const prisma = {
        order: { findUnique: jest.fn().mockResolvedValue(order) },
        $transaction: jest.fn((fn: (t: unknown) => unknown) => fn(tx)),
      };

      const service = new OrderLifecycleService(
        prisma as never,
        new EventEmitter2(),
        new OrderStateMachine(),
        new OrderTransitionService(),
        { restoreInTransaction: jest.fn() } as never,
        { awardForDeliveredOrder: jest.fn() } as never,
        { rewardForDeliveredOrder: jest.fn() } as never,
        { openForCancelledOrder: jest.fn() } as never,
        { record: jest.fn() } as never, // AdminAuditService (F-07)
        { enqueueInTransaction: jest.fn() } as never, // OutboxService (lot 4),
        { announce: async () => undefined } as never, // StockSignalService (F3-10)
      );

      await service.expireUnpaidOrder('o1');

      expect(history[0]).toMatchObject({
        fromStatus: 'EN_ATTENTE',
        toStatus: 'ANNULER',
        actionId: 'SYSTEM',
        actorUserId: null,
        source: 'CRON',
        reason: 'Paiement non reçu dans le délai imparti',
      });
    });
  });

  describe('confirmation d’encaissement — la provenance suit la source réelle', () => {
    /**
     * Les trois sources qui font avancer un paiement sont indépendantes
     * (webhook prestataire, sondage du client, cron de réconciliation) et
     * passent par le même point de transition. Elles ne doivent pas se
     * confondre dans l'historique : c'est ce qui permettra de dire si les
     * webhooks arrivent, ou si c'est le cron qui rattrape tout.
     */
    const cases: [PaymentEventSource, string][] = [
      [PaymentEventSource.WEBHOOK, 'WEBHOOK'],
      [PaymentEventSource.CLIENT_POLL, 'POLLING'],
      [PaymentEventSource.RECONCILIATION, 'CRON'],
      [PaymentEventSource.INITIATION, 'BACKEND'],
    ];

    it.each(cases)('%s → source %s', async (paymentSource, expected) => {
      const payment = {
        id: 'p1',
        orderId: 'o1',
        amount: 5320,
        currency: 'XAF',
        provider: 'PAWAPAY',
        providerTransactionId: 'dep-1',
        status: 'PENDING',
        order: {
          id: 'o1',
          userId: 'u-client',
          restaurantId: 'r1',
          status: 'EN_ATTENTE',
        },
      };

      tx = {
        payment: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
        order: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
        orderHistory: captureHistory(),
        // Aucune ligne de réglages : acceptation vendeur non mise en service.
        platformSettings: { findUnique: jest.fn().mockResolvedValue(null) },
      };

      const prisma = {
        payment: { findUnique: jest.fn().mockResolvedValue(payment) },
        $transaction: jest.fn((fn: (t: unknown) => unknown) => fn(tx)),
      };

      const service = new PaymentService(
        prisma as never,
        new EventEmitter2(),
        { get: (_k: string, d?: unknown) => d } as never,
        {} as never,
        {
          record: jest.fn().mockResolvedValue('evt-1'),
          setOutcome: jest.fn(),
        } as never,
        { enqueueInTransaction: jest.fn().mockResolvedValue('ob-1') } as never,
        new OrderTransitionService(),
      );

      await service.applyCollectionProviderStatus({
        paymentId: 'p1',
        source: paymentSource,
        status: {
          state: 'SUCCESS',
          rawStatus: 'COMPLETED',
          raw: {},
          amountXaf: 5320,
          currency: 'XAF',
        } as never,
      });

      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({
        fromStatus: 'EN_ATTENTE',
        toStatus: 'PAYER',
        actionId: 'SYSTEM',
        actorUserId: null,
        source: expected,
      });
    });
  });
});
