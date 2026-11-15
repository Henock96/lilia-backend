import { OrderStatus } from '@prisma/client';
import { OrderStatusUpdatedEvent } from '../events/order-events';
import { OrdersListener } from './orders.listener';

/**
 * Livraison clôturée par l'ADMIN (client qui refuse, livreur qui n'a pas
 * confirmé…) : la commande passe `LIVRER` sans remise constatée. Ni le client
 * ni le vendeur ne doivent recevoir « 🎉 Commande livrée ».
 */
describe('OrdersListener.handleOrderStatusUpdated — clôture par l’ADMIN', () => {
  let notifications: { sendPushNotification: jest.Mock };
  let listener: OrdersListener;

  const event = (closure?: 'DELIVERY_ARBITRATION') =>
    new OrderStatusUpdatedEvent(
      'order-abc123',
      'c-1',
      'r-1',
      OrderStatus.PRET,
      OrderStatus.LIVRER,
      'admin-1',
      { restaurantName: 'Chez Awa' },
      undefined,
      closure,
    );

  beforeEach(() => {
    const prisma = {
      // Commande en livraison : pas de message de retrait.
      order: { findFirst: jest.fn().mockResolvedValue(null) },
      restaurant: {
        findUnique: jest.fn().mockResolvedValue({ ownerId: 'owner-1' }),
      },
    };
    notifications = {
      sendPushNotification: jest.fn().mockResolvedValue({ accepted: 1 }),
    };
    listener = new OrdersListener(
      notifications as never,
      prisma as never,
      { broadcastOrderStatus: jest.fn() } as never,
      {} as never,
    );
    jest.spyOn(listener['logger'], 'log').mockImplementation(() => undefined);
  });

  const pushTo = (userId: string) =>
    notifications.sendPushNotification.mock.calls.find(([to]) => to === userId);

  it('envoie un message de clôture au client et au vendeur', async () => {
    await listener.handleOrderStatusUpdated(event('DELIVERY_ARBITRATION'));

    const client = pushTo('c-1');
    expect(client?.[1]).toBe('📦 Commande clôturée');
    expect(client?.[2]).toContain('#ABC123');
    expect(client?.[2]).not.toMatch(/livrée|appétit/);

    const vendor = pushTo('owner-1');
    expect(vendor?.[1]).toBe('📦 Commande clôturée');
    expect(vendor?.[2]).toContain('paiement suit le circuit habituel');
    expect(vendor?.[2]).not.toContain('livrée au client');
  });

  it('garde « Commande livrée » pour une livraison ordinaire', async () => {
    await listener.handleOrderStatusUpdated(event());

    expect(pushTo('c-1')?.[1]).toBe('🎉 Commande livrée');
    expect(pushTo('owner-1')?.[2]).toContain('livrée au client');
  });
});
