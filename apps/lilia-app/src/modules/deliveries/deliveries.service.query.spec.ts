import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
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
 * Tests de CARACTÉRISATION des lectures de DeliveriesService (LIL-134) :
 * findAllForRestaurant, findAllForDeliverer, findOne, getAvailableDeliverers,
 * getMyAssignedDeliveries, findByOrderId (+ contrôle anti-IDOR
 * assertCanViewDelivery). Fige le comportement avant extraction d'un
 * DeliveryQueryService. Doit rester vert après extraction.
 */
describe('DeliveriesService (caractérisation — lectures)', () => {
  let service: DeliveriesService;

  const prisma = {
    restaurant: { findFirst: jest.fn() },
    delivery: { findMany: jest.fn(), count: jest.fn(), findUnique: jest.fn() },
    user: { findUnique: jest.fn(), findMany: jest.fn() },
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DeliveriesService,
        DeliveryQueryService, // service réel : DeliveriesService y délègue les lectures
        DeliveryAssignmentService, // requis par DeliveriesService — non sollicité ici
        { provide: PrismaService, useValue: prisma },
        { provide: NotificationsService, useValue: {} },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
        { provide: OrderStateMachine, useValue: {} },
        { provide: PlatformSettingsService, useValue: {} },
        { provide: TrackingGateway, useValue: {} },
        { provide: TrackingService, useValue: {} },
      ],
    }).compile();
    service = module.get<DeliveriesService>(DeliveriesService);
  });

  describe('findAllForRestaurant', () => {
    it('Forbidden si l’utilisateur ne possède pas de restaurant', async () => {
      prisma.restaurant.findFirst.mockResolvedValue(null);
      await expect(service.findAllForRestaurant('uid')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('retourne { data, meta } filtré sur le restaurant + statut', async () => {
      prisma.restaurant.findFirst.mockResolvedValue({ id: 'r1' });
      prisma.delivery.findMany.mockResolvedValue([{ id: 'd1' }]);
      prisma.delivery.count.mockResolvedValue(1);

      const res = await service.findAllForRestaurant('uid', 'EN_TRANSIT' as any, 2, 10);

      const args = prisma.delivery.findMany.mock.calls[0][0];
      expect(args.where).toEqual({ order: { restaurantId: 'r1' }, status: 'EN_TRANSIT' });
      expect(args.skip).toBe(10);
      expect(res.meta).toEqual({ total: 1, page: 2, limit: 10, totalPages: 1 });
    });
  });

  describe('findAllForDeliverer', () => {
    it('NotFound si l’utilisateur est introuvable', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      await expect(service.findAllForDeliverer('uid')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('retourne { data, count } filtré sur le livreur', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'u1' });
      prisma.delivery.findMany.mockResolvedValue([{ id: 'd1' }, { id: 'd2' }]);
      const res = await service.findAllForDeliverer('uid');
      expect(prisma.delivery.findMany.mock.calls[0][0].where).toEqual({ delivererId: 'u1' });
      expect(res).toEqual({ data: [{ id: 'd1' }, { id: 'd2' }], count: 2 });
    });
  });

  describe('findOne (anti-IDOR)', () => {
    const baseDelivery = {
      id: 'd1',
      delivererId: 'liv1',
      order: {
        userId: 'client1',
        restaurant: { nom: 'Resto', owner: { firebaseUid: 'ownerUid' } },
      },
    };

    it('NotFound si la livraison est introuvable', async () => {
      prisma.delivery.findUnique.mockResolvedValue(null);
      await expect(service.findOne('d1', 'uid')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('autorise le restaurateur propriétaire (match firebaseUid) sans lookup user', async () => {
      prisma.delivery.findUnique.mockResolvedValue(baseDelivery);
      const res = await service.findOne('d1', 'ownerUid');
      expect(prisma.user.findUnique).not.toHaveBeenCalled();
      // le champ interne owner est retiré de la réponse
      expect(res.data.order.restaurant).not.toHaveProperty('owner');
    });

    it('autorise le client propriétaire de la commande', async () => {
      prisma.delivery.findUnique.mockResolvedValue(baseDelivery);
      prisma.user.findUnique.mockResolvedValue({ id: 'client1', role: 'CLIENT' });
      const res = await service.findOne('d1', 'clientUid');
      expect(res.data.id).toBe('d1');
    });

    it('Forbidden pour un tiers non lié', async () => {
      prisma.delivery.findUnique.mockResolvedValue(baseDelivery);
      prisma.user.findUnique.mockResolvedValue({ id: 'stranger', role: 'CLIENT' });
      await expect(service.findOne('d1', 'strangerUid')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });
  });

  describe('getAvailableDeliverers', () => {
    it('retourne { data, count } des livreurs', async () => {
      prisma.user.findMany.mockResolvedValue([{ id: 'l1' }]);
      const res = await service.getAvailableDeliverers();
      expect(prisma.user.findMany.mock.calls[0][0].where).toEqual({ role: 'LIVREUR' });
      expect(res).toEqual({ data: [{ id: 'l1' }], count: 1 });
    });
  });

  describe('findByOrderId (anti-IDOR)', () => {
    const delivery = {
      id: 'd1',
      status: 'EN_TRANSIT',
      delivererId: 'liv1',
      order: {
        userId: 'client1',
        deliveryLatitude: 1,
        deliveryLongitude: 2,
        restaurant: { id: 'r1', nom: 'Resto', owner: { firebaseUid: 'ownerUid' } },
      },
    };

    it('NotFound si aucune livraison pour la commande', async () => {
      prisma.delivery.findUnique.mockResolvedValue(null);
      await expect(service.findByOrderId('o1', 'uid')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('client propriétaire : retourne data sans champs internes', async () => {
      prisma.delivery.findUnique.mockResolvedValue(delivery);
      prisma.user.findUnique.mockResolvedValue({ id: 'client1', role: 'CLIENT' });
      const res = await service.findByOrderId('o1', 'clientUid');
      expect(res.data).not.toHaveProperty('delivererId');
      expect(res.data.order).not.toHaveProperty('userId');
      expect(res.data.order.restaurant).not.toHaveProperty('owner');
    });
  });
});
