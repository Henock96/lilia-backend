import { OrderStatus } from '@prisma/client';

import { OrderLifecycleService } from '../orders/order-lifecycle.service';
import { OrderStateMachine } from '../orders/order-state.machine';
import { OrderTransitionService } from '../orders/order-transition.service';
import { OrderAcceptanceTimeoutService } from './order-acceptance-timeout.service';

/**
 * Commande payée que le vendeur n'accepte pas à temps (F3-01, D1 = 8 min).
 *
 * C'est la garantie centrale de la vague 1 : aucun client débité n'attend une
 * réponse qui ne viendra jamais. La commande est annulée par le SYSTÈME, tout
 * est restitué, et le remboursement dû est écrit dans la même transaction —
 * le worker, qui exécute ce cron, n'a aucun listener : tout effet de bord
 * passe par l'outbox.
 */
describe('Expiration des commandes non acceptées (F3-01)', () => {
  const NOW = new Date('2026-09-24T12:10:00.000Z');
  beforeAll(() =>
    jest.useFakeTimers({
      now: NOW.getTime(),
      doNotFake: ['nextTick', 'setImmediate'],
    }),
  );
  afterAll(() => jest.useRealTimers());

  describe('OrderLifecycleService.expireUnacceptedOrder', () => {
    function build(
      order: Partial<{ status: OrderStatus; acceptDeadlineAt: Date | null }>,
    ) {
      const row = {
        id: 'o-1',
        userId: 'u-client',
        restaurantId: 'r-1',
        status: 'PAYER' as OrderStatus,
        acceptDeadlineAt: new Date('2026-09-24T12:08:00.000Z'),
        items: [{ productId: 'p-1', quantite: 1 }],
        ...order,
      };
      const tx = {
        order: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
        orderHistory: { create: jest.fn().mockResolvedValue({}) },
        platformSettings: { findUnique: jest.fn().mockResolvedValue(null) },
        loyaltyTransaction: {
          aggregate: jest.fn().mockResolvedValue({ _sum: { points: 0 } }),
        },
        promoUsage: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
      };
      const prisma = {
        order: { findUnique: jest.fn().mockResolvedValue(row) },
        $transaction: jest.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
      };
      const stock = { restoreInTransaction: jest.fn() };
      const outbox = { enqueueInTransaction: jest.fn() };
      const service = new OrderLifecycleService(
        prisma as never,
        { emit: jest.fn() } as never,
        new OrderStateMachine(),
        new OrderTransitionService(),
        stock as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        outbox as never,
        { announce: async () => undefined } as never, // StockSignalService (F3-10)
      );
      return { service, tx, stock, outbox };
    }

    it('échéance dépassée : ANNULER par le SYSTÈME, restitutions et dettes écrites dans la transaction', async () => {
      const { service, tx, stock, outbox } = build({});

      await expect(service.expireUnacceptedOrder('o-1')).resolves.toBe(true);

      expect(tx.order.updateMany.mock.calls[0][0]).toMatchObject({
        where: { id: 'o-1', status: 'PAYER' },
        data: { status: 'ANNULER' },
      });
      expect(tx.orderHistory.create.mock.calls[0][0].data).toMatchObject({
        actionId: 'SYSTEM',
        source: 'CRON',
      });
      expect(stock.restoreInTransaction).toHaveBeenCalledWith(
        tx,
        [{ productId: 'p-1', quantite: 1 }],
        // F3-10 — la date de la commande décide de la restitution d'un
        // quota du jour (réservation antérieure au reset : rien à rendre).
        expect.objectContaining({ orderCreatedAt: undefined }),
      );
      const types = outbox.enqueueInTransaction.mock.calls.map(
        (c) => c[1].type,
      );
      expect(types).toEqual(
        expect.arrayContaining([
          'order.refund_due',
          'order.acceptance_expired',
        ]),
      );
      const refundDue = outbox.enqueueInTransaction.mock.calls.find(
        (c) => c[1].type === 'order.refund_due',
      );
      expect(refundDue?.[1].payload).toMatchObject({ vendorFault: true });
    });

    it.each<
      [string, Partial<{ status: OrderStatus; acceptDeadlineAt: Date | null }>]
    >([
      [
        'échéance pas encore atteinte',
        { acceptDeadlineAt: new Date('2026-09-24T12:15:00.000Z') },
      ],
      [
        'commande sans échéance (antérieure à la mise en service)',
        { acceptDeadlineAt: null },
      ],
      ['commande déjà acceptée', { status: 'ACCEPTEE' }],
    ])('ne touche à rien : %s', async (_label, order) => {
      const { service, tx, outbox } = build(order);

      await expect(service.expireUnacceptedOrder('o-1')).resolves.toBe(false);
      expect(tx.order.updateMany).not.toHaveBeenCalled();
      expect(outbox.enqueueInTransaction).not.toHaveBeenCalled();
    });

    it('acceptation gagnée de justesse : la transition perdue n’écrit aucune dette', async () => {
      const { service, tx, outbox } = build({});
      tx.order.updateMany.mockResolvedValue({ count: 0 });

      await expect(service.expireUnacceptedOrder('o-1')).resolves.toBe(false);
      expect(outbox.enqueueInTransaction).not.toHaveBeenCalled();
    });
  });

  describe('OrderAcceptanceTimeoutService', () => {
    function build(required: boolean, candidates: Array<{ id: string }>) {
      const prisma = {
        platformSettings: {
          findUnique: jest
            .fn()
            .mockResolvedValue({ orderAcceptanceRequired: required }),
        },
        order: { findMany: jest.fn().mockResolvedValue(candidates) },
      };
      const lifecycle = {
        expireUnacceptedOrder: jest.fn().mockResolvedValue(true),
      };
      const lock = {
        runExclusively: jest.fn((_n, _t, task: () => unknown) => task()),
      };
      const service = new OrderAcceptanceTimeoutService(
        prisma as never,
        lifecycle as never,
        lock as never,
      );
      return { service, prisma, lifecycle };
    }

    it('interrupteur éteint : ne cherche même pas', async () => {
      const { service, prisma, lifecycle } = build(false, [{ id: 'o-1' }]);

      await service.expireUnacceptedOrders();

      expect(prisma.order.findMany).not.toHaveBeenCalled();
      expect(lifecycle.expireUnacceptedOrder).not.toHaveBeenCalled();
    });

    it('interrupteur allumé : cible les PAYER dont l’échéance est passée, et les expire une à une', async () => {
      const { service, prisma, lifecycle } = build(true, [
        { id: 'o-1' },
        { id: 'o-2' },
      ]);

      await service.expireUnacceptedOrders();

      expect(prisma.order.findMany.mock.calls[0][0].where).toEqual({
        status: 'PAYER',
        acceptDeadlineAt: { lte: NOW },
      });
      expect(
        lifecycle.expireUnacceptedOrder.mock.calls.map((c) => c[0]),
      ).toEqual(['o-1', 'o-2']);
    });

    it('une commande en échec n’empêche pas les suivantes', async () => {
      const { service, lifecycle } = build(true, [
        { id: 'o-1' },
        { id: 'o-2' },
      ]);
      lifecycle.expireUnacceptedOrder.mockRejectedValueOnce(
        new Error('deadlock'),
      );

      await service.expireUnacceptedOrders();

      expect(lifecycle.expireUnacceptedOrder).toHaveBeenCalledTimes(2);
    });
  });
});
