import { AdminAuditService } from '../admin-audit/admin-audit.service';
import { OutboxService } from '../outbox/outbox.service';
import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { DeliveriesService } from './deliveries.service';
import { DeliveryQueryService } from './delivery-query.service';
import { DeliveryAssignmentService } from './delivery-assignment.service';
import { DeliveryAssignmentLogService } from './delivery-assignment-log.service';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { OrderStateMachine } from '../orders/order-state.machine';
import { PlatformSettingsService } from '../platform-settings/platform-settings.service';
import { TrackingGateway } from '../tracking/tracking.gateway';
import { TrackingService } from '../tracking/tracking.service';
import { LoyaltyService } from '../loyalty/loyalty.service';
import { ReferralService } from '../users/referral.service';
import { OrderTransitionService } from '../orders/order-transition.service';

/**
 * Tests de CARACTÉRISATION des lectures de DeliveriesService (LIL-134) :
 * findAllForRestaurant, findAllForDeliverer, findOne, getAvailableDeliverers,
 * getMyAssignedDeliveries, findByOrderId (+ contrôle anti-IDOR
 * assertCanViewDelivery). Fige le comportement avant extraction d'un
 * DeliveryQueryService. Doit rester vert après extraction.
 */
/// Double du service de tracking : seule la purge de position est appelée
/// depuis le dispatch (à la réassignation), et elle est best-effort.
const trackingServiceDouble = {
  forgetLastPosition: jest.fn().mockResolvedValue(undefined),
};

describe('DeliveriesService (caractérisation — lectures)', () => {
  let service: DeliveriesService;

  const prisma = {
    restaurant: { findFirst: jest.fn() },
    delivery: { findMany: jest.fn(), count: jest.fn(), findUnique: jest.fn() },
    user: { findUnique: jest.fn(), findMany: jest.fn() },
    deliveryHandover: { findUnique: jest.fn() },
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        // Journal d'audit : conclusion d'une course par un ADMIN (F-06).
        { provide: AdminAuditService, useValue: { record: jest.fn() } },
        // Obligations durables écrites dans la transaction `LIVRER` (lot 4).
        {
          provide: OutboxService,
          useValue: { enqueueInTransaction: jest.fn() },
        },
        // P0-4 : `Order.status` ne s'écrit plus qu'à travers ce service,
        // qui historise la transition dans la même transaction.
        OrderTransitionService,
        {
          provide: LoyaltyService,
          useValue: {
            awardForDeliveredOrder: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          // Le parrainage est arbitré au même endroit que la fidélité depuis
          // que son déclencheur est passé du paiement à la livraison.
          provide: ReferralService,
          useValue: {
            rewardForDeliveredOrder: jest.fn().mockResolvedValue(undefined),
          },
        },
        DeliveriesService,
        DeliveryQueryService, // service réel : DeliveriesService y délègue les lectures
        DeliveryAssignmentService, // requis par DeliveriesService — non sollicité ici
        { provide: PrismaService, useValue: prisma },
        // Service réel : le journal d'assignation s'écrit dans la même
        // transaction que le statut, ses écritures doivent être exercées.
        DeliveryAssignmentLogService,
        { provide: NotificationsService, useValue: {} },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
        { provide: OrderStateMachine, useValue: {} },
        { provide: PlatformSettingsService, useValue: {} },
        { provide: TrackingGateway, useValue: {} },
        { provide: TrackingService, useValue: trackingServiceDouble },
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

      const res = await service.findAllForRestaurant(
        'uid',
        'EN_TRANSIT' as any,
        2,
        10,
      );

      const args = prisma.delivery.findMany.mock.calls[0][0];
      expect(args.where).toEqual({
        order: { restaurantId: 'r1' },
        status: 'EN_TRANSIT',
      });
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

    it('retourne { data, count, meta } filtré sur le livreur', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'u1' });
      prisma.delivery.findMany.mockResolvedValue([{ id: 'd1' }, { id: 'd2' }]);
      prisma.delivery.count.mockResolvedValue(2);
      const res = await service.findAllForDeliverer('uid');
      expect(prisma.delivery.findMany.mock.calls[0][0].where).toEqual({
        delivererId: 'u1',
      });
      // Paginé depuis le fix P1 : l'historique complet du livreur était
      // renvoyé d'un bloc, commandes et produits inclus.
      expect(res.data).toEqual([{ id: 'd1' }, { id: 'd2' }]);
      expect(res.count).toBe(2);
      expect(res.meta).toEqual({
        page: 1,
        limit: 20,
        total: 2,
        hasMore: false,
      });
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
      prisma.user.findUnique.mockResolvedValue({
        id: 'client1',
        role: 'CLIENT',
      });
      const res = await service.findOne('d1', 'clientUid');
      expect(res.data.id).toBe('d1');
    });

    it('Forbidden pour un tiers non lié', async () => {
      prisma.delivery.findUnique.mockResolvedValue(baseDelivery);
      prisma.user.findUnique.mockResolvedValue({
        id: 'stranger',
        role: 'CLIENT',
      });
      await expect(service.findOne('d1', 'strangerUid')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });
  });

  describe('getAvailableDeliverers', () => {
    it('retourne { data, count } des livreurs', async () => {
      prisma.user.findMany.mockResolvedValue([{ id: 'l1' }]);
      const res = await service.getAvailableDeliverers();
      // Fix L11 : la requête ne ramène plus tous les comptes LIVREUR de la
      // plateforme — les comptes bloqués/supprimés et hors ligne sont exclus.
      //
      // `driverProfile: { isActive: true }` (septembre 2026) doit dire EXACTEMENT
      // la même chose que `assertAssignable` côté écriture. Si l'une des deux
      // bouge sans l'autre, la liste propose des livreurs que l'assignation
      // refuse — ou, pire, en cache que l'assignation accepterait.
      expect(prisma.user.findMany.mock.calls[0][0].where).toEqual({
        role: 'LIVREUR',
        statusUser: 'ACTIVE',
        driverProfile: { isActive: true },
        OR: [
          { driverStatus: { in: ['AVAILABLE', 'ON_DELIVERY'] } },
          { driverStatus: null },
        ],
      });
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
        restaurant: {
          id: 'r1',
          nom: 'Resto',
          owner: { firebaseUid: 'ownerUid' },
        },
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
      prisma.user.findUnique.mockResolvedValue({
        id: 'client1',
        role: 'CLIENT',
      });
      const res = await service.findByOrderId('o1', 'clientUid');
      expect(res.data).not.toHaveProperty('delivererId');
      expect(res.data.order).not.toHaveProperty('userId');
      expect(res.data.order.restaurant).not.toHaveProperty('owner');
    });

    // ─── F-06 : le code de remise ne va qu'au client ───────────────────────
    describe('code de remise (F-06)', () => {
      beforeEach(() => {
        prisma.deliveryHandover.findUnique.mockResolvedValue({ code: '4821' });
      });

      it('le client propriétaire le voit pendant que la course roule', async () => {
        prisma.delivery.findUnique.mockResolvedValue(delivery);
        prisma.user.findUnique.mockResolvedValue({
          id: 'client1',
          role: 'CLIENT',
        });
        const res = await service.findByOrderId('o1', 'clientUid');
        expect(res.data.handoverCode).toBe('4821');
      });

      it('le livreur assigné ne le voit JAMAIS — c’est à lui qu’on le dicte', async () => {
        prisma.delivery.findUnique.mockResolvedValue(delivery);
        prisma.user.findUnique.mockResolvedValue({
          id: 'liv1',
          role: 'LIVREUR',
        });
        const res = await service.findByOrderId('o1', 'livUid');
        expect(res.data.handoverCode).toBeNull();
        expect(prisma.deliveryHandover.findUnique).not.toHaveBeenCalled();
      });

      it('l’admin ne le voit pas non plus (il conclut par arbitrage, pas par le code)', async () => {
        prisma.delivery.findUnique.mockResolvedValue(delivery);
        prisma.user.findUnique.mockResolvedValue({ id: 'adm', role: 'ADMIN' });
        const res = await service.findByOrderId('o1', 'admUid');
        expect(res.data.handoverCode).toBeNull();
      });

      it('course pas encore récupérée : pas de code à montrer', async () => {
        prisma.delivery.findUnique.mockResolvedValue({
          ...delivery,
          status: 'ACCEPTER',
        });
        prisma.user.findUnique.mockResolvedValue({
          id: 'client1',
          role: 'CLIENT',
        });
        const res = await service.findByOrderId('o1', 'clientUid');
        expect(res.data.handoverCode).toBeNull();
      });
    });
  });
});
