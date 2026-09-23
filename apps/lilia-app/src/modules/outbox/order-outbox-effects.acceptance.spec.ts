import { OrderStatus } from '@prisma/client';

import { OrderOutboxEffectsService } from './order-outbox-effects.service';

/**
 * Remboursement automatique d'une faute vendeur (F3-01, décision D2) et
 * prévenance d'une commande non acceptée.
 *
 * Le remboursement automatique ne crée AUCUN chemin d'argent nouveau : il
 * appelle l'exécution existante (verrou de commande, blocage si un reversement
 * existe, CAS PENDING → PROCESSING), celle qu'un administrateur déclenche à la
 * main. Il ne part que si les trois conditions sont réunies : faute vendeur,
 * réglage actif, remboursement réellement ouvert.
 */
describe('OrderOutboxEffectsService — faute vendeur (F3-01)', () => {
  function build(opts: {
    autoRefund?: boolean;
    opened?: { id: string; amount: number } | null;
    orderStatus?: OrderStatus;
  }) {
    const prisma = {
      order: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'o-1',
          userId: 'u-client',
          status: opts.orderStatus ?? 'ANNULER',
          total: 6750,
          restaurant: { nom: 'Chez Awa', ownerId: 'u-vendor' },
        }),
      },
      platformSettings: {
        findUnique: jest.fn().mockResolvedValue({
          autoRefundVendorFault: opts.autoRefund ?? true,
        }),
      },
    };
    const outbox = { markSent: jest.fn(), markFailed: jest.fn() };
    const dispatcher = { registerHandler: jest.fn() };
    const notifications = {
      sendPushNotification: jest.fn().mockResolvedValue(undefined),
    };
    const refunds = {
      openForCancelledOrder: jest
        .fn()
        .mockResolvedValue(
          opts.opened === undefined
            ? { id: 'rf-1', amount: 6750 }
            : opts.opened,
        ),
    };
    const execution = {
      execute: jest.fn().mockResolvedValue({ status: 'PROCESSING' }),
    };
    const service = new OrderOutboxEffectsService(
      prisma as never,
      outbox as never,
      dispatcher as never,
      notifications as never,
      {} as never,
      {} as never,
      refunds as never,
      execution as never,
    );
    return { service, outbox, notifications, execution };
  }

  const refundDue = (payload: Record<string, unknown>) =>
    ({
      id: 'evt-1',
      type: 'order.refund_due',
      aggregateId: 'o-1',
      payload,
    }) as never;

  describe('order.refund_due', () => {
    it('faute vendeur + réglage actif : le remboursement ouvert est exécuté, sans administrateur', async () => {
      const { service, execution, outbox } = build({});

      await service.dispatchRefundDue(
        refundDue({ reason: 'x', vendorFault: true }),
      );

      expect(execution.execute).toHaveBeenCalledWith('rf-1', null);
      expect(outbox.markSent).toHaveBeenCalledWith('evt-1');
    });

    it.each<[string, Parameters<typeof build>[0], Record<string, unknown>]>([
      ['réglage désactivé', { autoRefund: false }, { vendorFault: true }],
      ['annulation ordinaire (pas une faute vendeur)', {}, { reason: 'x' }],
      [
        'rien d’encaissé (aucun remboursement ouvert)',
        { opened: null },
        { vendorFault: true },
      ],
    ])('reste dans la file admin : %s', async (_label, opts, payload) => {
      const { service, execution, outbox } = build(opts);

      await service.dispatchRefundDue(refundDue(payload));

      expect(execution.execute).not.toHaveBeenCalled();
      expect(outbox.markSent).toHaveBeenCalledWith('evt-1');
    });

    it('exécution refusée (mode MANUAL, reversement en cours…) : la dette reste ouverte, l’obligation est acquittée', async () => {
      const { service, execution, outbox } = build({});
      execution.execute.mockRejectedValue(
        new Error('Le mode MANUAL ne permet pas…'),
      );

      await expect(
        service.dispatchRefundDue(refundDue({ vendorFault: true })),
      ).resolves.toBeUndefined();
      // Rejouer n'y changerait rien : c'est désormais une décision humaine,
      // et le remboursement PENDING est dans la file admin.
      expect(outbox.markSent).toHaveBeenCalledWith('evt-1');
    });
  });

  describe('order.acceptance_expired', () => {
    const expired = {
      id: 'evt-2',
      type: 'order.acceptance_expired',
      aggregateId: 'o-1',
      payload: {},
    } as never;

    it('prévient le client (remboursement lancé) ET le vendeur (commande perdue)', async () => {
      const { service, notifications, outbox } = build({});

      await service.dispatchOrderAcceptanceExpired(expired);

      const recipients = notifications.sendPushNotification.mock.calls.map(
        (c) => c[0],
      );
      expect(recipients).toEqual(
        expect.arrayContaining(['u-client', 'u-vendor']),
      );
      const toClient = notifications.sendPushNotification.mock.calls.find(
        (c) => c[0] === 'u-client',
      );
      expect(toClient?.[2]).toMatch(/rembours/i);
      expect(outbox.markSent).toHaveBeenCalledWith('evt-2');
    });

    it('commande qui n’est plus annulée : rien à annoncer', async () => {
      const { service, notifications, outbox } = build({
        orderStatus: 'ACCEPTEE',
      });

      await service.dispatchOrderAcceptanceExpired(expired);

      expect(notifications.sendPushNotification).not.toHaveBeenCalled();
      expect(outbox.markSent).toHaveBeenCalledWith('evt-2');
    });

    it('le traitement est inscrit auprès du dispatcher au démarrage', () => {
      const { service } = build({});
      const dispatcher = (
        service as unknown as { dispatcher: { registerHandler: jest.Mock } }
      ).dispatcher;

      service.onModuleInit();

      expect(dispatcher.registerHandler.mock.calls.map((c) => c[0])).toContain(
        'order.acceptance_expired',
      );
    });
  });
});
