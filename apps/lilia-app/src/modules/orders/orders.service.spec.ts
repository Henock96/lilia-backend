import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException, ForbiddenException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ConfigService } from '@nestjs/config';

import { OrdersService } from './orders.service';
import { OrderQueryService } from './order-query.service';
import { PrismaService } from '../../prisma/prisma.service';
import { PaginationService } from '../../common/pagination/pagination.service';
import { OrderStateMachine } from './order-state.machine';
import { StockService } from './stock.service';
import { OrderValidatorService } from './order-validator.service';
import { OrderCalculatorService } from './order-calculator.service';
import { PromoService } from '../promo/promo.service';
import { PlatformSettingsService } from '../platform-settings/platform-settings.service';
import { PreorderValidatorService } from '../vendors/preorder-validator.service';
import { QuartiersService } from '../quartiers/quartiers.service';

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
    order: { findUnique: jest.fn(), findMany: jest.fn(), count: jest.fn() },
    restaurant: { findFirst: jest.fn() },
  };
  const pagination = {
    getPaginationMeta: jest.fn((page: number, limit: number, total: number) => ({
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    })),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OrdersService,
        OrderQueryService, // service réel : OrdersService y délègue les lectures
        { provide: PrismaService, useValue: prisma },
        { provide: PaginationService, useValue: pagination },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
        { provide: ConfigService, useValue: { get: () => undefined } }, // pas de REDIS_URL → redis = null
        { provide: OrderStateMachine, useValue: {} },
        { provide: StockService, useValue: {} },
        { provide: OrderValidatorService, useValue: {} },
        { provide: OrderCalculatorService, useValue: {} },
        { provide: PromoService, useValue: {} },
        { provide: PlatformSettingsService, useValue: {} },
        { provide: PreorderValidatorService, useValue: {} },
        { provide: QuartiersService, useValue: {} },
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
      const order = { id: 'o1', userId: 'u1' };
      prisma.user.findUnique.mockResolvedValue({ id: 'u1', role: 'CLIENT' });
      prisma.order.findUnique.mockResolvedValue(order);
      await expect(service.findOrderById('o1', 'uid')).resolves.toBe(order);
    });

    it('retourne la commande d’autrui à un ADMIN', async () => {
      const order = { id: 'o1', userId: 'autre' };
      prisma.user.findUnique.mockResolvedValue({ id: 'u1', role: 'ADMIN' });
      prisma.order.findUnique.mockResolvedValue(order);
      await expect(service.findOrderById('o1', 'uid')).resolves.toBe(order);
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

      expect(res.data).toBe(orders);
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

      expect(res.data).toEqual([{ id: 'o1' }]);
      expect(prisma.restaurant.findFirst).not.toHaveBeenCalled();
      // pas de filtre `where` sur le findMany ADMIN
      expect(prisma.order.findMany.mock.calls[0][0].where).toBeUndefined();
    });

    it('RESTAURATEUR : lève NotFoundException sans restaurant rattaché', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'r1', role: 'RESTAURATEUR' });
      prisma.restaurant.findFirst.mockResolvedValue(null);
      await expect(
        service.findRestaurantOrders('uid', 1, 20),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('RESTAURATEUR : retourne uniquement les commandes de son restaurant', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'r1', role: 'RESTAURATEUR' });
      prisma.restaurant.findFirst.mockResolvedValue({ id: 'resto1' });
      prisma.order.findMany.mockResolvedValue([{ id: 'o1' }]);
      prisma.order.count.mockResolvedValue(1);

      const res = await service.findRestaurantOrders('uid', 1, 20);

      expect(res.data).toEqual([{ id: 'o1' }]);
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
      const res = await service.findOrdersByUserId('u1', { role: 'ADMIN' });
      expect(res).toEqual({ data: [{ id: 'o1' }] });
      expect(prisma.order.findMany.mock.calls[0][0].where).toEqual({
        userId: 'u1',
        deleteCommande: false,
      });
    });

    it('retourne { data } sans caller (appel interne)', async () => {
      prisma.order.findMany.mockResolvedValue([]);
      const res = await service.findOrdersByUserId('u1');
      expect(res).toEqual({ data: [] });
    });
  });
});
