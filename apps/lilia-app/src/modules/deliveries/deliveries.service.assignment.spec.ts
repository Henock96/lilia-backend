import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { DeliveriesService } from './deliveries.service';
import { DeliveryQueryService } from './delivery-query.service';
import { DeliveryAssignmentService } from './delivery-assignment.service';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { OrderStateMachine } from '../orders/order-state.machine';
import { PlatformSettingsService } from '../platform-settings/platform-settings.service';
import { TrackingGateway } from '../tracking/tracking.gateway';
import { TrackingService } from '../tracking/tracking.service';

/**
 * Tests de CARACTÉRISATION de l'assignation/acceptation de DeliveriesService
 * (LIL-134) : assignDeliverer, assignDelivererToOrder, acceptDelivery.
 * Fige le comportement avant extraction d'un DeliveryAssignmentService.
 */
describe('DeliveriesService (caractérisation — assignation)', () => {
  let service: DeliveriesService;

  const tx = {};
  const prisma = {
    delivery: {
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    order: { findUnique: jest.fn(), update: jest.fn() },
    user: { findUnique: jest.fn(), update: jest.fn() },
    $transaction: jest.fn(async (arg: any) =>
      Array.isArray(arg) ? Promise.all(arg) : arg(tx),
    ),
  };
  const notifications = { sendPushNotification: jest.fn() };
  const stateMachine = { assertTransition: jest.fn() };
  const eventEmitter = { emit: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DeliveriesService,
        DeliveryQueryService,
        DeliveryAssignmentService, // service réel : DeliveriesService y délègue l'assignation
        { provide: PrismaService, useValue: prisma },
        { provide: NotificationsService, useValue: notifications },
        { provide: EventEmitter2, useValue: eventEmitter },
        { provide: OrderStateMachine, useValue: stateMachine },
        { provide: PlatformSettingsService, useValue: {} },
        { provide: TrackingGateway, useValue: {} },
        { provide: TrackingService, useValue: {} },
      ],
    }).compile();
    service = module.get<DeliveriesService>(DeliveriesService);
  });

  // user lookups : firebaseUid → demandeur (owner/admin) ; id → livreur cible
  const mockUsers = (requester: any, deliverer: any) => {
    prisma.user.findUnique.mockImplementation(({ where }: any) =>
      Promise.resolve(where.firebaseUid ? requester : deliverer),
    );
  };

  describe('assignDeliverer', () => {
    it('NotFound si la livraison est introuvable', async () => {
      prisma.delivery.findUnique.mockResolvedValue(null);
      await expect(
        service.assignDeliverer('d1', 'liv1', 'uid'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('owner assigne un LIVREUR : passe la livraison en ASSIGNER + notifie', async () => {
      prisma.delivery.findUnique.mockResolvedValue({
        id: 'd1',
        orderId: 'o1',
        order: { isPreorder: false, scheduledFor: null, restaurant: { nom: 'Resto', owner: { firebaseUid: 'uid' } } },
      });
      mockUsers({ id: 'u1', role: 'RESTAURATEUR' }, { id: 'liv1', role: 'LIVREUR' });
      prisma.delivery.update.mockResolvedValue({ id: 'd1', status: 'ASSIGNER' });

      const res = await service.assignDeliverer('d1', 'liv1', 'uid');

      expect(prisma.delivery.update.mock.calls[0][0].data).toEqual({ delivererId: 'liv1', status: 'ASSIGNER' });
      expect(notifications.sendPushNotification).toHaveBeenCalled();
      expect(res).toEqual({ data: { id: 'd1', status: 'ASSIGNER' }, message: 'Livreur assigné avec succès' });
    });

    it('refuse une cible qui n’est pas LIVREUR', async () => {
      prisma.delivery.findUnique.mockResolvedValue({
        id: 'd1', orderId: 'o1',
        order: { restaurant: { nom: 'Resto', owner: { firebaseUid: 'uid' } } },
      });
      mockUsers({ id: 'u1', role: 'ADMIN' }, { id: 'x', role: 'CLIENT' });
      await expect(
        service.assignDeliverer('d1', 'x', 'uid'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('assignDelivererToOrder', () => {
    it('BadRequest si la commande n’est pas dans un statut assignable', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'u1', role: 'ADMIN' });
      prisma.order.findUnique.mockResolvedValue({
        id: 'o1', status: 'EN_ATTENTE',
        restaurant: { owner: { firebaseUid: 'other' } },
      });
      await expect(
        service.assignDelivererToOrder('o1', 'liv1', 'uid'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('crée la livraison si absente puis assigne', async () => {
      // getUserOrThrow (firebaseUid) → admin ; puis lookup livreur (id)
      mockUsers({ id: 'u1', role: 'ADMIN' }, { id: 'liv1', role: 'LIVREUR' });
      prisma.order.findUnique.mockResolvedValue({
        id: 'o1', status: 'PRET',
        restaurant: { nom: 'Resto', owner: { firebaseUid: 'other' } },
      });
      prisma.delivery.findUnique
        .mockResolvedValueOnce(null) // pas de delivery existante
        .mockResolvedValueOnce({ // rechargée avec relations pour _doAssign
          id: 'd1', orderId: 'o1',
          order: { isPreorder: false, scheduledFor: null, restaurant: { nom: 'Resto', owner: { firebaseUid: 'other' } } },
        });
      prisma.delivery.create.mockResolvedValue({ id: 'd1' });
      prisma.delivery.update.mockResolvedValue({ id: 'd1', status: 'ASSIGNER' });

      const res = await service.assignDelivererToOrder('o1', 'liv1', 'uid');

      expect(prisma.delivery.create).toHaveBeenCalledWith({ data: { orderId: 'o1', status: 'EN_ATTENTE' } });
      expect(res.message).toBe('Livreur assigné avec succès');
    });
  });

  describe('acceptDelivery', () => {
    const assigned = {
      id: 'd1',
      orderId: 'o1',
      delivererId: 'liv1',
      status: 'ASSIGNER',
      order: { status: 'PRET', userId: 'c1', restaurantId: 'r1', total: 5000, restaurant: { nom: 'Resto' } },
    };

    it('Forbidden si la livraison n’est pas assignée à ce livreur', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'autre', driverStatus: 'AVAILABLE' });
      prisma.delivery.findUnique.mockResolvedValue(assigned);
      await expect(service.acceptDelivery('d1', 'uid')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('BadRequest si le livreur n’est pas AVAILABLE', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'liv1', driverStatus: 'ON_DELIVERY' });
      prisma.delivery.findUnique.mockResolvedValue(assigned);
      await expect(service.acceptDelivery('d1', 'uid')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('happy : transaction (EN_TRANSIT + ON_DELIVERY + EN_ROUTE) + émet order.status.updated', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'liv1', driverStatus: 'AVAILABLE' });
      prisma.delivery.findUnique.mockResolvedValue(assigned);
      prisma.delivery.update.mockResolvedValue({ id: 'd1', status: 'EN_TRANSIT' });
      prisma.user.update.mockResolvedValue({});
      prisma.order.update.mockResolvedValue({});

      const res = await service.acceptDelivery('d1', 'uid');

      expect(stateMachine.assertTransition).toHaveBeenCalledWith('PRET', 'EN_ROUTE', 'LIVREUR');
      expect(eventEmitter.emit).toHaveBeenCalledWith('order.status.updated', expect.anything());
      expect(res).toEqual({ id: 'd1', status: 'EN_TRANSIT' });
    });
  });
});
