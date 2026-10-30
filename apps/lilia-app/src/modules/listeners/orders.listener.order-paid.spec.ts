import { OrdersListener } from './orders.listener';

/**
 * Chemin rapide d'une commande payée (audit du 28/10/2026, F-01).
 *
 * Le listener acquittait l'obligation `order.paid` dès que le push « se
 * résolvait » — y compris sans token, Firebase non prêt ou tous les envois
 * refusés. Désormais il ne l'acquitte jamais : un push accepté reporte la
 * première reprise à l'échéance d'escalade ; refusé, il la laisse due.
 */
describe('OrdersListener.handleOrderPaid', () => {
  const paidAt = new Date('2026-10-29T10:00:00Z');
  let prisma: {
    order: { findUnique: jest.Mock };
    platformSettings: { findUnique: jest.Mock };
  };
  let notifications: { sendPushNotification: jest.Mock };
  let outbox: { markSent: jest.Mock; deferUntil: jest.Mock };
  let tracking: { broadcastOrderStatus: jest.Mock };
  let listener: OrdersListener;

  const orderRow = (over: Record<string, unknown> = {}) => ({
    total: 6400,
    isDelivery: true,
    scheduledFor: null,
    paidAt,
    acceptDeadlineAt: null,
    _count: { items: 2 },
    restaurant: { ownerId: 'owner-1', nom: 'Chez Awa' },
    ...over,
  });

  const event = {
    orderId: 'o-1',
    userId: 'c-1',
    restaurantId: 'r-1',
    paymentId: 'p-1',
    amount: 6400,
    outboxId: 'evt-1',
  };

  beforeEach(() => {
    prisma = {
      order: { findUnique: jest.fn().mockResolvedValue(orderRow()) },
      platformSettings: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ vendorAcceptanceReminderLeadMinutes: 3 }),
      },
    };
    notifications = {
      sendPushNotification: jest
        .fn()
        .mockResolvedValue({ accepted: 1, failed: 0, devices: 1 }),
    };
    outbox = {
      markSent: jest.fn().mockResolvedValue(undefined),
      deferUntil: jest.fn().mockResolvedValue(undefined),
    };
    tracking = { broadcastOrderStatus: jest.fn() };
    listener = new OrdersListener(
      notifications as never,
      prisma as never,
      tracking as never,
      outbox as never,
    );
    jest.spyOn(listener['logger'], 'error').mockImplementation(() => undefined);
    jest.spyOn(listener['logger'], 'log').mockImplementation(() => undefined);
  });

  it.each([
    ['aucun token', { accepted: 0, failed: 0, devices: 0, reason: 'NO_TOKEN' }],
    [
      'Firebase non initialisé',
      { accepted: 0, failed: 0, devices: 0, reason: 'FIREBASE_NOT_READY' },
    ],
    [
      'tous refusés',
      { accepted: 0, failed: 1, devices: 1, reason: 'ALL_FAILED' },
    ],
  ])(
    '%s : ni acquittement ni report — le dispatcher reprend aussitôt',
    async (_l, r) => {
      notifications.sendPushNotification.mockResolvedValue(r);

      await listener.handleOrderPaid(event);

      expect(outbox.markSent).not.toHaveBeenCalled();
      expect(outbox.deferUntil).not.toHaveBeenCalled();
    },
  );

  it('push qui lève : ni acquittement ni report', async () => {
    notifications.sendPushNotification.mockRejectedValue(new Error('boom'));

    await listener.handleOrderPaid(event);

    expect(outbox.markSent).not.toHaveBeenCalled();
    expect(outbox.deferUntil).not.toHaveBeenCalled();
  });

  it('push accepté, sans échéance : pas d’acquittement, reprise reportée à paiement + 10 min', async () => {
    await listener.handleOrderPaid(event);

    expect(outbox.markSent).not.toHaveBeenCalled();
    expect(outbox.deferUntil).toHaveBeenCalledWith(
      'evt-1',
      new Date(paidAt.getTime() + 10 * 60_000),
    );
  });

  it('push accepté, avec échéance d’acceptation : reprise à échéance − 3 min', async () => {
    const deadline = new Date(paidAt.getTime() + 8 * 60_000);
    prisma.order.findUnique.mockResolvedValue(
      orderRow({ acceptDeadlineAt: deadline }),
    );

    await listener.handleOrderPaid(event);

    expect(outbox.deferUntil).toHaveBeenCalledWith(
      'evt-1',
      new Date(deadline.getTime() - 3 * 60_000),
    );
  });

  it('un seul push vendeur par traitement (pas de doublon sur le chemin rapide)', async () => {
    await listener.handleOrderPaid(event);
    expect(notifications.sendPushNotification).toHaveBeenCalledTimes(1);
    expect(notifications.sendPushNotification.mock.calls[0][3]).toEqual(
      expect.objectContaining({ type: 'new_order', orderId: 'o-1' }),
    );
  });
});
