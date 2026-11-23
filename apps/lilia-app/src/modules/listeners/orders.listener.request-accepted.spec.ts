import { OrderStatus, OutboxEventStatus } from '@prisma/client';
import { OrderStatusUpdatedEvent } from '../events/order-events';
import { ORDER_REQUEST_ACCEPTED_EVENT } from '../outbox/outbox-events';
import { OrdersListener } from './orders.listener';

/**
 * Lot 3 — « accepter puis payer » : le vendeur accepte la demande, le client
 * doit être prévenu **dans la seconde** qu'il peut payer.
 *
 * Constaté le 22/11/2026 (démo, pawaPay sandbox) : le listener ne poussait
 * rien et laissait l'outbox s'en charger. Or l'outbox ne reprend qu'après son
 * délai de grâce (60 s, dépilée toutes les 30 s) — et abandonne si la commande
 * n'est plus `EN_ATTENTE`. Acceptée à 20:37:07, payée à 20:37:58 sans avoir
 * été prévenue, reprise à 20:38:30 : aucune notification n'est jamais partie.
 */
describe('OrdersListener — demande acceptée (« payez maintenant »)', () => {
  let notifications: { sendPushNotification: jest.Mock };
  let outbox: { markSent: jest.Mock };
  let prisma: {
    outboxEvent: { findFirst: jest.Mock };
    order: { findUnique: jest.Mock; findFirst: jest.Mock };
    restaurant: { findUnique: jest.Mock };
  };
  let listener: OrdersListener;

  const accepted = () =>
    new OrderStatusUpdatedEvent(
      'order-abc123',
      'c-1',
      'r-1',
      OrderStatus.DEMANDE_ENVOYEE,
      OrderStatus.EN_ATTENTE,
      'owner-1',
      { restaurantName: 'Chez Awa' },
    );

  const order = (status: OrderStatus = OrderStatus.EN_ATTENTE) => ({
    id: 'order-abc123',
    userId: 'c-1',
    status,
    total: 3225,
    paymentDueAt: new Date(Date.now() + 10 * 60_000),
    restaurant: { nom: 'Chez Awa' },
  });

  beforeEach(() => {
    prisma = {
      outboxEvent: {
        findFirst: jest.fn().mockResolvedValue({ id: 'evt-1' }),
      },
      order: {
        findUnique: jest.fn().mockResolvedValue(order()),
        findFirst: jest.fn().mockResolvedValue(null),
      },
      restaurant: { findUnique: jest.fn().mockResolvedValue(null) },
    };
    notifications = {
      sendPushNotification: jest
        .fn()
        .mockResolvedValue({ accepted: 1, failed: 0, devices: 1 }),
    };
    outbox = { markSent: jest.fn().mockResolvedValue(undefined) };
    listener = new OrdersListener(
      notifications as never,
      prisma as never,
      { broadcastOrderStatus: jest.fn() } as never,
      outbox as never,
    );
    jest.spyOn(listener['logger'], 'log').mockImplementation(() => undefined);
  });

  it('prévient le client tout de suite, puis acquitte l’outbox', async () => {
    await listener.handleOrderStatusUpdated(accepted());

    expect(prisma.outboxEvent.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          type: ORDER_REQUEST_ACCEPTED_EVENT,
          aggregateId: 'order-abc123',
          status: OutboxEventStatus.PENDING,
        },
      }),
    );
    expect(notifications.sendPushNotification).toHaveBeenCalledTimes(1);
    const [to, title, body, data] =
      notifications.sendPushNotification.mock.calls[0];
    expect(to).toBe('c-1');
    expect(title).toBe('✅ Commande acceptée — payez maintenant');
    expect(body).toContain('Chez Awa a accepté votre commande');
    expect(body).toContain('3225 FCFA');
    expect(data).toEqual({
      orderId: 'order-abc123',
      type: 'order_update',
      status: 'EN_ATTENTE',
      action: 'pay',
    });
    expect(outbox.markSent).toHaveBeenCalledWith('evt-1');
  });

  it('push refusé (aucun appareil) : l’obligation reste due pour l’outbox', async () => {
    notifications.sendPushNotification.mockResolvedValue({
      accepted: 0,
      failed: 0,
      devices: 0,
      reason: 'NO_TOKEN',
    });

    await listener.handleOrderStatusUpdated(accepted());

    expect(outbox.markSent).not.toHaveBeenCalled();
  });

  it('obligation déjà traitée : aucun second push', async () => {
    prisma.outboxEvent.findFirst.mockResolvedValue(null);

    await listener.handleOrderStatusUpdated(accepted());

    expect(notifications.sendPushNotification).not.toHaveBeenCalled();
  });

  it('commande déjà payée entre-temps : on ne demande pas de payer', async () => {
    prisma.order.findUnique.mockResolvedValue(order(OrderStatus.PAYER));

    await listener.handleOrderStatusUpdated(accepted());

    expect(notifications.sendPushNotification).not.toHaveBeenCalled();
  });
});
