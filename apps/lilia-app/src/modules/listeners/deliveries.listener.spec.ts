import { Test, TestingModule } from '@nestjs/testing';
import {
  DeliveryStatus,
  DriverStatus,
  IncidentSeverity,
  IncidentType,
} from '@prisma/client';

import { DeliveriesListener } from './deliveries.listener';
import { NotificationsService } from '../notifications/notifications.service';
import { IncidentsService } from '../incidents/incidents.service';
import { PrismaService } from '../../prisma/prisma.service';
import {
  DeliveryAssignedEvent,
  DeliveryFailedEvent,
} from '../events/delivery-events';

/**
 * Le livreur ne recevait qu'**une seule** notification sur tout le cycle de vie
 * — « Nouvelle mission » à l'assignation. Ni la commande prête, ni l'annulation,
 * ni le retrait de sa mission ne lui parvenaient, et un échec de livraison
 * n'émettait strictement rien : la commande restait EN_ROUTE pour toujours.
 */
describe('DeliveriesListener', () => {
  let listener: DeliveriesListener;
  const notifications = { sendPushNotification: jest.fn() };
  const incidents = { create: jest.fn() };
  const prisma = {
    restaurant: { findUnique: jest.fn() },
    delivery: { findUnique: jest.fn() },
    user: { updateMany: jest.fn() },
  };

  /** Titres des notifications envoyées à un destinataire donné. */
  const titlesFor = (userId: string) =>
    notifications.sendPushNotification.mock.calls
      .filter((c) => c[0] === userId)
      .map((c) => c[1]);

  beforeEach(async () => {
    jest.clearAllMocks();
    notifications.sendPushNotification.mockResolvedValue(undefined);
    incidents.create.mockResolvedValue({ id: 'inc-1' });
    prisma.user.updateMany.mockResolvedValue({ count: 1 });
    prisma.restaurant.findUnique.mockResolvedValue({ ownerId: 'owner-1' });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DeliveriesListener,
        { provide: NotificationsService, useValue: notifications },
        { provide: IncidentsService, useValue: incidents },
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    listener = module.get(DeliveriesListener);
  });

  const assigned = (over: Partial<DeliveryAssignedEvent> = {}) =>
    new DeliveryAssignedEvent(
      'd1',
      'o1',
      'resto1',
      (over.delivererId as string) ?? 'liv-new',
      'Chez Maman Lili',
      (over.orderStatus as string) ?? 'PAYER',
      (over.isPreorder as boolean) ?? false,
      (over.scheduledFor as Date | null) ?? null,
      (over.previousDelivererId as string | null) ?? null,
    );

  describe('assignation', () => {
    it('notifie le livreur et précise que la commande n’est pas encore prête', async () => {
      await listener.handleAssigned(assigned());

      const [userId, title, body, data] =
        notifications.sendPushNotification.mock.calls[0];
      expect(userId).toBe('liv-new');
      expect(title).toBe('🚚 Nouvelle mission');
      // L'assignation est autorisée dès PAYER : le livreur doit savoir qu'il
      // n'a pas à partir tout de suite.
      expect(body).toContain('pas encore prête');
      expect(data.type).toBe('delivery_assigned');
    });

    it('dit « à récupérer » quand la commande est déjà prête', async () => {
      await listener.handleAssigned(assigned({ orderStatus: 'PRET' } as never));

      expect(notifications.sendPushNotification.mock.calls[0][2]).toContain(
        'à récupérer',
      );
    });

    it('libère ET prévient l’ancien livreur lors d’une réassignation', async () => {
      await listener.handleAssigned(
        assigned({ previousDelivererId: 'liv-old' } as never),
      );

      // Sans cette libération, l'ancien livreur restait ON_DELIVERY à vie et
      // ne pouvait plus accepter aucune course.
      expect(prisma.user.updateMany).toHaveBeenCalledWith({
        where: { id: 'liv-old', driverStatus: DriverStatus.ON_DELIVERY },
        data: { driverStatus: DriverStatus.AVAILABLE },
      });
      expect(titlesFor('liv-old')).toContain('↩️ Mission retirée');
      expect(titlesFor('liv-new')).toContain('🚚 Nouvelle mission');
    });

    it('ne libère personne sur une première assignation', async () => {
      await listener.handleAssigned(assigned());

      expect(prisma.user.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('commande prête', () => {
    it('prévient le livreur assigné qui attendait', async () => {
      prisma.delivery.findUnique.mockResolvedValue({
        id: 'd1',
        delivererId: 'liv-1',
        status: 'ASSIGNER',
        order: {
          restaurantId: 'resto1',
          restaurant: { nom: 'Chez Maman Lili' },
        },
      });

      await listener.handleOrderStatusUpdated({
        orderId: 'o1',
        newStatus: 'PRET',
      });

      expect(titlesFor('liv-1')).toContain('📦 Commande prête');
    });

    it('ne dit rien si le livreur est déjà parti avec la commande', async () => {
      prisma.delivery.findUnique.mockResolvedValue({
        id: 'd1',
        delivererId: 'liv-1',
        status: 'EN_TRANSIT',
        order: { restaurantId: 'resto1', restaurant: { nom: 'R' } },
      });

      await listener.handleOrderStatusUpdated({
        orderId: 'o1',
        newStatus: 'PRET',
      });

      expect(notifications.sendPushNotification).not.toHaveBeenCalled();
    });

    it('ignore les autres statuts de commande', async () => {
      await listener.handleOrderStatusUpdated({
        orderId: 'o1',
        newStatus: 'EN_PREPARATION',
      });

      expect(prisma.delivery.findUnique).not.toHaveBeenCalled();
    });
  });

  describe('échec de livraison', () => {
    /// Deux échecs, distingués par l'état de la course au moment du signalement.
    const failedAt = (previousStatus: DeliveryStatus) =>
      new DeliveryFailedEvent(
        'd1',
        'o1abcdef',
        'resto1',
        'client-1',
        'liv-1',
        'Chez Maman Lili',
        'Client injoignable',
        'liv-1',
        previousStatus,
      );

    /** Échec en pleine course : le client attend dans la rue. */
    const failed = failedAt(DeliveryStatus.EN_TRANSIT);

    /** Désistement avant récupération : le repas est encore au comptoir. */
    const failedBeforePickup = failedAt(DeliveryStatus.ACCEPTER);

    it('prévient le vendeur avec une action explicite', async () => {
      await listener.handleFailed(failed);

      const call = notifications.sendPushNotification.mock.calls.find(
        (c) => c[0] === 'owner-1',
      );
      expect(call[1]).toContain('action requise');
      expect(call[2]).toContain('Client injoignable');
      expect(call[2]).toContain('Réassignez');
      expect(call[3].requiresAction).toBe('true');
    });

    it('informe le client, qui restait sur « livreur en chemin »', async () => {
      await listener.handleFailed(failed);

      expect(titlesFor('client-1')).toContain('Incident de livraison');
    });

    it('n’alarme PAS le client quand le livreur se désiste avant récupération', async () => {
      // La commande est encore `PRET` au comptoir : le client n'a jamais été
      // prévenu d'un départ. Lui annoncer que sa commande « n'a pas pu être
      // livrée » l'inquiéterait pour un incident invisible de son côté, que le
      // vendeur règle en réassignant un livreur.
      await listener.handleFailed(failedBeforePickup);

      expect(titlesFor('client-1')).toHaveLength(0);
    });

    it('prévient quand même le vendeur, qui doit réassigner', async () => {
      await listener.handleFailed(failedBeforePickup);

      const call = notifications.sendPushNotification.mock.calls.find(
        (c) => c[0] === 'owner-1',
      );
      expect(call[1]).toContain('désisté');
      expect(call[2]).toContain('toujours chez vous');
    });

    it('ne classe pas un désistement annoncé comme un livreur disparu', async () => {
      // `DRIVER_NO_SHOW` / `HIGH` pour un livreur qui prévient d'une panne
      // avant de partir, c'est sanctionner le comportement qu'on veut
      // encourager. L'incident reste tracé — la commande doit être
      // réassignée — mais sans accusation.
      await listener.handleFailed(failedBeforePickup);

      expect(incidents.create).toHaveBeenCalledWith(
        expect.objectContaining({
          type: IncidentType.OTHER,
          severity: IncidentSeverity.MEDIUM,
        }),
      );
    });

    it('libère le livreur et trace un incident', async () => {
      await listener.handleFailed(failed);

      expect(prisma.user.updateMany).toHaveBeenCalledWith({
        where: { id: 'liv-1', driverStatus: DriverStatus.ON_DELIVERY },
        data: { driverStatus: DriverStatus.AVAILABLE },
      });
      expect(incidents.create).toHaveBeenCalledWith(
        expect.objectContaining({
          type: IncidentType.DRIVER_NO_SHOW,
          orderId: 'o1abcdef',
          riderId: 'liv-1',
          description: 'Client injoignable',
        }),
      );
    });

    it('n’échoue pas si la création d’incident tombe', async () => {
      incidents.create.mockRejectedValue(new Error('DB down'));

      await expect(listener.handleFailed(failed)).resolves.toBeUndefined();
      // Les notifications partent quand même.
      expect(titlesFor('client-1')).toContain('Incident de livraison');
    });
  });

  describe('annulation de la commande', () => {
    it('prévient le livreur assigné et le libère', async () => {
      prisma.delivery.findUnique.mockResolvedValue({
        id: 'd1',
        delivererId: 'liv-1',
        status: 'ASSIGNER',
      });

      await listener.handleOrderCancelled({
        orderId: 'o1abcdef',
        restaurantId: 'resto1',
      });

      expect(titlesFor('liv-1')).toContain('❌ Mission annulée');
      expect(prisma.user.updateMany).toHaveBeenCalled();
    });

    it('ne réveille pas un livreur dont la course est déjà terminée', async () => {
      prisma.delivery.findUnique.mockResolvedValue({
        id: 'd1',
        delivererId: 'liv-1',
        status: 'LIVRER',
      });

      await listener.handleOrderCancelled({
        orderId: 'o1',
        restaurantId: 'resto1',
      });

      expect(notifications.sendPushNotification).not.toHaveBeenCalled();
    });

    it('ne fait rien si aucun livreur n’était mobilisé', async () => {
      prisma.delivery.findUnique.mockResolvedValue(null);

      await listener.handleOrderCancelled({
        orderId: 'o1',
        restaurantId: 'resto1',
      });

      expect(notifications.sendPushNotification).not.toHaveBeenCalled();
    });
  });
});
