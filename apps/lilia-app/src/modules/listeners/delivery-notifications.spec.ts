import { Test, TestingModule } from '@nestjs/testing';

import { DeliveriesListener } from './deliveries.listener';
import { OrdersListener } from './orders.listener';
import { NotificationsService } from '../notifications/notifications.service';
import { IncidentsService } from '../incidents/incidents.service';
import { PrismaService } from '../../prisma/prisma.service';
import { TrackingGateway } from '../tracking/tracking.gateway';
import { OutboxService } from '../outbox/outbox.service';
import {
  DeliveryAcceptedEvent,
  DeliveryAssignedEvent,
  DeliveryPickedUpEvent,
} from '../events/delivery-events';
import { OrderStatusUpdatedEvent } from '../events/order-events';

/**
 * QUI est notifié, à QUEL moment.
 *
 * La règle que ces tests protègent :
 *
 *   ACCEPTER UNE MISSION ≠ ÊTRE EN ROUTE VERS LE CLIENT.
 *
 * Le client recevait « 🛵 votre livreur est en chemin » dès que le livreur
 * appuyait sur « Accepter », alors qu'il n'avait pas encore quitté son
 * domicile. C'est cette confusion — et le doublon de notification vendeur
 * qu'elle entraînait — qui est verrouillée ici.
 */
describe('Notifications du flux de livraison', () => {
  let deliveriesListener: DeliveriesListener;
  let ordersListener: OrdersListener;

  const notifications = { sendPushNotification: jest.fn() };
  const prisma = {
    restaurant: { findUnique: jest.fn() },
    delivery: { findUnique: jest.fn() },
    user: { updateMany: jest.fn() },
  };
  const trackingGateway = { broadcastOrderStatus: jest.fn() };

  const RESTO_OWNER = 'owner-1';
  const CLIENT = 'client-1';
  const DRIVER = 'driver-1';

  beforeEach(async () => {
    jest.resetAllMocks();
    notifications.sendPushNotification.mockResolvedValue(undefined);
    prisma.restaurant.findUnique.mockResolvedValue({ ownerId: RESTO_OWNER });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DeliveriesListener,
        OrdersListener,
        { provide: NotificationsService, useValue: notifications },
        { provide: IncidentsService, useValue: { create: jest.fn() } },
        { provide: PrismaService, useValue: prisma },
        { provide: TrackingGateway, useValue: trackingGateway },
        { provide: OutboxService, useValue: { markSent: jest.fn() } },
      ],
    }).compile();

    deliveriesListener = module.get(DeliveriesListener);
    ordersListener = module.get(OrdersListener);
  });

  /** Destinataires de toutes les notifications envoyées pendant le test. */
  const recipients = () =>
    notifications.sendPushNotification.mock.calls.map((c) => c[0]);

  /** Corps de toutes les notifications envoyées, concaténés. */
  const allText = () =>
    notifications.sendPushNotification.mock.calls
      .map((c) => `${c[1]} ${c[2]}`)
      .join(' | ');

  describe('Étape A — le restaurant assigne', () => {
    it('notifie le LIVREUR, et personne d’autre', async () => {
      await deliveriesListener.handleAssigned(
        new DeliveryAssignedEvent(
          'd1',
          'o1',
          'r1',
          DRIVER,
          'Chez Awa',
          'PRET',
          false,
          null,
          null,
        ),
      );

      expect(recipients()).toEqual([DRIVER]);
      expect(recipients()).not.toContain(CLIENT);
    });
  });

  describe('Étape B — le livreur accepte', () => {
    it('notifie le RESTAURANT, jamais le client', async () => {
      await deliveriesListener.handleAccepted(
        new DeliveryAcceptedEvent('d1', 'o1', 'r1', DRIVER, 'John'),
      );

      expect(recipients()).toEqual([RESTO_OWNER]);
      // Le point central de toute la correction.
      expect(recipients()).not.toContain(CLIENT);
      expect(allText()).toContain('accepté');
      expect(allText()).not.toMatch(/en route|en chemin/i);
    });

    it('nomme le livreur quand on le connaît', async () => {
      await deliveriesListener.handleAccepted(
        new DeliveryAcceptedEvent('d1', 'o1', 'r1', DRIVER, 'John'),
      );
      expect(allText()).toContain('John');
    });

    it('reste lisible si le livreur n’a pas de nom renseigné', async () => {
      await deliveriesListener.handleAccepted(
        new DeliveryAcceptedEvent('d1', 'o1', 'r1', DRIVER, null),
      );
      expect(allText()).toContain('Le livreur a accepté');
    });
  });

  describe('Étape C — le livreur récupère le repas', () => {
    it('notifie le RESTAURANT que la commande est partie', async () => {
      await deliveriesListener.handlePickedUp(
        new DeliveryPickedUpEvent('d1', 'o1', 'r1', DRIVER, 'John', CLIENT),
      );

      expect(recipients()).toEqual([RESTO_OWNER]);
      expect(allText()).toContain('récupéré');
    });

    it('le CLIENT est prévenu par order.status.updated → EN_ROUTE', async () => {
      await ordersListener.handleOrderStatusUpdated(
        new OrderStatusUpdatedEvent(
          'o1',
          CLIENT,
          'r1',
          'PRET',
          'EN_ROUTE',
          DRIVER,
          {
            restaurantName: 'Chez Awa',
          },
        ),
      );

      // Le client, et LUI SEUL : le restaurant a déjà été prévenu par
      // `delivery.picked_up`, avec un message qui dit quelque chose.
      expect(recipients()).toEqual([CLIENT]);
      expect(allText()).toContain('En route');
    });

    it('EN_ROUTE ne déclenche PAS de seconde notification au restaurant', async () => {
      await ordersListener.handleOrderStatusUpdated(
        new OrderStatusUpdatedEvent(
          'o1',
          CLIENT,
          'r1',
          'PRET',
          'EN_ROUTE',
          DRIVER,
          {
            restaurantName: 'Chez Awa',
          },
        ),
      );

      expect(recipients()).not.toContain(RESTO_OWNER);
      // On ne va même pas chercher le restaurant en base.
      expect(prisma.restaurant.findUnique).not.toHaveBeenCalled();
    });
  });

  describe('Étape D — la commande est livrée', () => {
    it('notifie le CLIENT et le RESTAURANT, une fois chacun', async () => {
      await ordersListener.handleOrderStatusUpdated(
        new OrderStatusUpdatedEvent(
          'o1',
          CLIENT,
          'r1',
          'EN_ROUTE',
          'LIVRER',
          DRIVER,
          {
            restaurantName: 'Chez Awa',
          },
        ),
      );

      expect(recipients()).toHaveLength(2);
      expect(recipients()).toContain(CLIENT);
      expect(recipients()).toContain(RESTO_OWNER);
      // Plus d'enum brute (« Commande #abc : LIVRER ») côté vendeur.
      expect(allText()).toContain('livrée');
      expect(allText()).not.toContain('LIVRER');
    });
  });

  describe('La commande devient prête pendant que le livreur vient', () => {
    it.each(['ASSIGNER', 'ACCEPTER'])(
      'prévient le livreur au statut %s',
      async (status) => {
        prisma.delivery.findUnique.mockResolvedValue({
          id: 'd1',
          delivererId: DRIVER,
          status,
          order: { restaurantId: 'r1', restaurant: { nom: 'Chez Awa' } },
        });

        await deliveriesListener.handleOrderStatusUpdated({
          orderId: 'o1',
          newStatus: 'PRET',
        });

        expect(recipients()).toEqual([DRIVER]);
      },
    );

    it('ne le prévient plus une fois qu’il est parti avec la commande', async () => {
      prisma.delivery.findUnique.mockResolvedValue({
        id: 'd1',
        delivererId: DRIVER,
        status: 'EN_TRANSIT',
        order: { restaurantId: 'r1', restaurant: { nom: 'Chez Awa' } },
      });

      await deliveriesListener.handleOrderStatusUpdated({
        orderId: 'o1',
        newStatus: 'PRET',
      });

      expect(notifications.sendPushNotification).not.toHaveBeenCalled();
    });
  });
});
