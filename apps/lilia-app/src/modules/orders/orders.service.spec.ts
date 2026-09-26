import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException, ForbiddenException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ConfigService } from '@nestjs/config';

import { OrdersService } from './orders.service';
import { OrderQueryService } from './order-query.service';
import { OrderCheckoutService } from './order-checkout.service';
import { OrderLifecycleService } from './order-lifecycle.service';
import { OrderReorderService } from './order-reorder.service';
import { PrismaService } from '../../prisma/prisma.service';
import { PaginationService } from '../../common/pagination/pagination.service';
import { OrderStateMachine } from './order-state.machine';
import { OrderTransitionService } from './order-transition.service';
import { StockService } from './stock.service';
import { StockSignalService } from './stock-signal.service';
import { CartService } from '../cart/cart.service';
import { OrderValidatorService } from './order-validator.service';
import { OrderCalculatorService } from './order-calculator.service';
import { PromoService } from '../promo/promo.service';
import { PlatformSettingsService } from '../platform-settings/platform-settings.service';
import { PreorderValidatorService } from '../vendors/preorder-validator.service';
import { QuartiersService } from '../quartiers/quartiers.service';
import { DeliveryDestinationService } from './delivery-destination.service';
import { DeliveryPricingService } from '../delivery-pricing/delivery-pricing.service';
import { LoyaltyService } from '../loyalty/loyalty.service';
import { ReferralService } from '../users/referral.service';
import { RefundsService } from '../refunds/refunds.service';
import { AdminAuditService } from '../admin-audit/admin-audit.service';
import { OutboxService } from '../outbox/outbox.service';

/**
 * Tests de CARACTÉRISATION de OrdersService — méthodes de lecture.
 *
 * Objectif : figer le comportement OBSERVABLE actuel des méthodes de lecture
 * (findOrderById, findOrdersClient, findRestaurantOrders, findOrdersByUserId)
 * AVANT de les extraire dans un `OrderQueryService` (LIL-134). Ces tests doivent
 * rester verts pendant et après le refactor (OrdersService deviendra une façade
 * déléguant au nouveau service).
 *
 * Ce ne sont pas des tests « idéaux » : ils décrivent ce que le code FAIT
 * aujourd'hui, pas ce qu'il devrait faire.
 */
describe('OrdersService (caractérisation — lectures)', () => {
  let service: OrdersService;

  const prisma = {
    user: { findUnique: jest.fn() },
    order: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      // `groupBy` alimente `meta.statusCounts` : les onglets de l'écran
      // Commandes comptaient dans la page reçue, ils comptent désormais dans
      // le périmètre entier (audit du 09/09/2026).
      groupBy: jest.fn(),
    },
    restaurant: { findFirst: jest.fn() },
    // Aucune ligne de réglages : acceptation vendeur hors service (F3-01).
    platformSettings: { findUnique: jest.fn().mockResolvedValue(null) },
    // F3-07 / D-P5 — code de retrait au comptoir.
    pickupHandover: { findUnique: jest.fn().mockResolvedValue(null) },
  };
  const pagination = {
    getPaginationMeta: jest.fn(
      (page: number, limit: number, total: number) => ({
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      }),
    ),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    prisma.order.groupBy.mockResolvedValue([]);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        {
          provide: OutboxService,
          useValue: {
            enqueueInTransaction: jest.fn().mockResolvedValue('outbox-1'),
            markSent: jest.fn().mockResolvedValue(undefined),
          },
        },
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
        {
          provide: RefundsService,
          useValue: {
            openForCancelledOrder: jest.fn().mockResolvedValue(null),
          },
        },
        // Journal d'audit des gestes ADMIN sur une commande (F-07).
        { provide: AdminAuditService, useValue: { record: jest.fn() } },
        OrdersService,
        OrderQueryService, // service réel : OrdersService y délègue les lectures
        OrderCheckoutService, // requis par OrdersService — non sollicité par les lectures
        OrderLifecycleService, // requis par OrdersService — non sollicité par les lectures
        OrderReorderService, // requis par OrdersService — non sollicité par les lectures
        { provide: PrismaService, useValue: prisma },
        { provide: PaginationService, useValue: pagination },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
        { provide: ConfigService, useValue: { get: () => undefined } }, // pas de REDIS_URL → redis = null
        { provide: OrderStateMachine, useValue: {} },
        OrderTransitionService,
        { provide: StockService, useValue: {} },
        { provide: StockSignalService, useValue: { announce: jest.fn() } },
        { provide: CartService, useValue: { addMenu: jest.fn() } },
        { provide: OrderValidatorService, useValue: {} },
        { provide: OrderCalculatorService, useValue: {} },
        { provide: PromoService, useValue: {} },
        { provide: PlatformSettingsService, useValue: {} },
        { provide: PreorderValidatorService, useValue: {} },
        { provide: QuartiersService, useValue: {} },
        {
          provide: DeliveryDestinationService,
          useValue: {},
        },
        {
          provide: DeliveryPricingService,
          useValue: { quoteForVendor: jest.fn().mockResolvedValue(null) },
        },
      ],
    }).compile();

    service = module.get<OrdersService>(OrdersService);
  });

  describe('findOrderById', () => {
    it('lève NotFoundException si l’utilisateur est introuvable', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      await expect(service.findOrderById('o1', 'uid')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(prisma.order.findUnique).not.toHaveBeenCalled();
    });

    it('lève NotFoundException si la commande est introuvable', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'u1', role: 'CLIENT' });
      prisma.order.findUnique.mockResolvedValue(null);
      await expect(service.findOrderById('o1', 'uid')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('lève ForbiddenException si la commande n’appartient pas au client (non-ADMIN)', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'u1', role: 'CLIENT' });
      prisma.order.findUnique.mockResolvedValue({ id: 'o1', userId: 'autre' });
      await expect(service.findOrderById('o1', 'uid')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('retourne la commande au propriétaire', async () => {
      const order = { id: 'o1', userId: 'u1', isDelivery: true };
      prisma.user.findUnique.mockResolvedValue({ id: 'u1', role: 'CLIENT' });
      prisma.order.findUnique.mockResolvedValue(order);
      // La commande, plus les gestes permis à CE rôle (R1).
      await expect(service.findOrderById('o1', 'uid')).resolves.toEqual({
        ...order,
        allowedActions: expect.any(Array),
      });
    });

    describe('code de retrait (F3-07, I-18)', () => {
      const pickupOrder = (status: string) => ({
        id: 'o1',
        userId: 'u1',
        isDelivery: false,
        status,
        payoutDueAt: new Date(),
      });

      beforeEach(() =>
        prisma.pickupHandover.findUnique.mockResolvedValue({ code: '4821' }),
      );

      it('le client propriétaire lit son code tant que la commande est PRET', async () => {
        prisma.user.findUnique.mockResolvedValue({ id: 'u1', role: 'CLIENT' });
        prisma.order.findUnique.mockResolvedValue(pickupOrder('PRET'));
        const result = await service.findOrderById('o1', 'uid');
        expect(result).toMatchObject({ pickupCode: '4821' });
      });

      it('plus de code une fois la commande remise', async () => {
        prisma.user.findUnique.mockResolvedValue({ id: 'u1', role: 'CLIENT' });
        prisma.order.findUnique.mockResolvedValue(pickupOrder('LIVRER'));
        const result = await service.findOrderById('o1', 'uid');
        expect(result).toMatchObject({ pickupCode: null });
        expect(prisma.pickupHandover.findUnique).not.toHaveBeenCalled();
      });

      it('l’admin ne lit pas le code : il arbitre, il ne le dicte pas', async () => {
        prisma.user.findUnique.mockResolvedValue({ id: 'a1', role: 'ADMIN' });
        prisma.order.findUnique.mockResolvedValue(pickupOrder('PRET'));
        const result = await service.findOrderById('o1', 'uid');
        expect(result).not.toHaveProperty('pickupCode');
        expect(prisma.pickupHandover.findUnique).not.toHaveBeenCalled();
      });

      it('le client ne voit pas l’échéance de versement au vendeur', async () => {
        prisma.user.findUnique.mockResolvedValue({ id: 'u1', role: 'CLIENT' });
        prisma.order.findUnique.mockResolvedValue(pickupOrder('LIVRER'));
        const result = await service.findOrderById('o1', 'uid');
        expect(result).not.toHaveProperty('payoutDueAt');
      });
    });

    it('retourne la commande d’autrui à un ADMIN', async () => {
      const order = { id: 'o1', userId: 'autre' };
      prisma.user.findUnique.mockResolvedValue({ id: 'u1', role: 'ADMIN' });
      prisma.order.findUnique.mockResolvedValue(order);
      // La commande, plus les gestes permis à CE rôle (R1).
      await expect(service.findOrderById('o1', 'uid')).resolves.toEqual({
        ...order,
        allowedActions: expect.any(Array),
      });
    });
  });

  describe('findOrdersClient', () => {
    it('lève NotFoundException si l’utilisateur est introuvable', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      await expect(
        service.findOrdersClient(1, 10, 'uid'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('retourne { data, meta }, filtre deleteCommande:false et pagine', async () => {
      const orders = [{ id: 'o1' }];
      prisma.user.findUnique.mockResolvedValue({ id: 'u1', role: 'CLIENT' });
      prisma.order.findMany.mockResolvedValue(orders);
      prisma.order.count.mockResolvedValue(1);

      const res = await service.findOrdersClient(2, 5, 'uid');

      expect(res.data).toEqual([
        { ...orders[0], allowedActions: expect.any(Array) },
      ]);
      expect(pagination.getPaginationMeta).toHaveBeenCalledWith(2, 5, 1);
      const findArgs = prisma.order.findMany.mock.calls[0][0];
      expect(findArgs.skip).toBe(5); // (page-1)*limit
      expect(findArgs.take).toBe(5);
      expect(findArgs.where).toEqual({ userId: 'u1', deleteCommande: false });
    });
  });

  describe('findRestaurantOrders', () => {
    it('lève NotFoundException si l’utilisateur est introuvable', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      await expect(
        service.findRestaurantOrders('uid', 1, 20),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('ADMIN : retourne toutes les commandes sans filtre restaurant', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'a1', role: 'ADMIN' });
      prisma.order.findMany.mockResolvedValue([{ id: 'o1' }]);
      prisma.order.count.mockResolvedValue(1);

      const res = await service.findRestaurantOrders('uid', 1, 20);

      expect(res.data).toEqual([
        { id: 'o1', allowedActions: expect.any(Array) },
      ]);
      expect(prisma.restaurant.findFirst).not.toHaveBeenCalled();
      // Depuis le fix P1, le `count()` admin n'est plus sans filtre (scan
      // séquentiel complet à chaque page) : il exclut les soft-deletes, et le
      // findMany applique le même `where`.
      expect(prisma.order.findMany.mock.calls[0][0].where).toEqual({
        deleteCommande: false,
      });
      expect(prisma.order.count.mock.calls[0][0]).toEqual({
        where: { deleteCommande: false },
      });
    });

    it('RESTAURATEUR : lève NotFoundException sans restaurant rattaché', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'r1',
        role: 'RESTAURATEUR',
      });
      prisma.restaurant.findFirst.mockResolvedValue(null);
      await expect(
        service.findRestaurantOrders('uid', 1, 20),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('RESTAURATEUR : retourne uniquement les commandes de son restaurant', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'r1',
        role: 'RESTAURATEUR',
      });
      prisma.restaurant.findFirst.mockResolvedValue({ id: 'resto1' });
      prisma.order.findMany.mockResolvedValue([{ id: 'o1' }]);
      prisma.order.count.mockResolvedValue(1);

      const res = await service.findRestaurantOrders('uid', 1, 20);

      expect(res.data).toEqual([
        { id: 'o1', allowedActions: expect.any(Array) },
      ]);
      expect(prisma.order.findMany.mock.calls[0][0].where).toEqual({
        restaurantId: 'resto1',
      });
    });
  });

  describe('findOrdersByUserId', () => {
    it('lève ForbiddenException si le caller n’est pas ADMIN', async () => {
      await expect(
        service.findOrdersByUserId('u1', { role: 'CLIENT' }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.order.findMany).not.toHaveBeenCalled();
    });

    it('retourne { data } pour un ADMIN', async () => {
      prisma.order.findMany.mockResolvedValue([{ id: 'o1' }]);
      prisma.order.count.mockResolvedValue(1);
      const res = await service.findOrdersByUserId('u1', { role: 'ADMIN' });
      // Paginé depuis le fix P1 : la méthode ramenait toutes les commandes du
      // client, items et produits inclus.
      expect(res.data).toEqual([{ id: 'o1' }]);
      expect(res.meta).toEqual(
        expect.objectContaining({ page: 1, limit: 20, total: 1 }),
      );
      expect(prisma.order.findMany.mock.calls[0][0].where).toEqual({
        userId: 'u1',
        deleteCommande: false,
      });
    });

    it('retourne { data } sans caller (appel interne)', async () => {
      prisma.order.findMany.mockResolvedValue([]);
      prisma.order.count.mockResolvedValue(0);
      const res = await service.findOrdersByUserId('u1');
      expect(res.data).toEqual([]);
    });
  });
});
