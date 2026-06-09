import { Test, TestingModule } from '@nestjs/testing';
import {
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ConfigService } from '@nestjs/config';

import { OrdersService } from './orders.service';
import { OrderQueryService } from './order-query.service';
import { OrderCheckoutService } from './order-checkout.service';
import { OrderLifecycleService } from './order-lifecycle.service';
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
 * Tests de CARACTÉRISATION du cycle de vie commande (LIL-134) :
 * cancelOrder, updateOrderStatusByRestaurateur, deleteOrder,
 * reorderFromPreviousOrder. Fige le comportement avant extraction d'un
 * OrderLifecycleService. Doivent rester verts après extraction.
 */
describe('OrdersService (caractérisation — cycle de vie)', () => {
  let service: OrdersService;

  const tx = { order: { update: jest.fn() } };
  const prisma = {
    user: { findUnique: jest.fn(), update: jest.fn() },
    order: { findUnique: jest.fn(), update: jest.fn() },
    cart: { create: jest.fn(), findUnique: jest.fn() },
    cartItem: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      update: jest.fn(),
      create: jest.fn(),
    },
    loyaltyTransaction: { create: jest.fn() },
    $transaction: jest.fn(async (arg: any) =>
      typeof arg === 'function' ? arg(tx) : Promise.all(arg),
    ),
  };
  const stateMachine = { assertTransition: jest.fn() };
  const stockService = { restoreInTransaction: jest.fn() };
  const eventEmitter = { emit: jest.fn() };
  const platformSettings = {
    getSettings: jest.fn().mockResolvedValue({ loyaltyPointsPer100Xaf: 1 }),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    platformSettings.getSettings.mockResolvedValue({ loyaltyPointsPer100Xaf: 1 });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OrdersService,
        OrderQueryService,
        OrderCheckoutService,
        OrderLifecycleService, // service réel : OrdersService y délègue le cycle de vie
        { provide: PrismaService, useValue: prisma },
        { provide: OrderStateMachine, useValue: stateMachine },
        { provide: StockService, useValue: stockService },
        { provide: EventEmitter2, useValue: eventEmitter },
        { provide: PlatformSettingsService, useValue: platformSettings },
        { provide: ConfigService, useValue: { get: () => undefined } },
        { provide: PaginationService, useValue: {} },
        { provide: OrderValidatorService, useValue: {} },
        { provide: OrderCalculatorService, useValue: {} },
        { provide: PromoService, useValue: {} },
        { provide: PreorderValidatorService, useValue: {} },
        { provide: QuartiersService, useValue: {} },
      ],
    }).compile();

    service = module.get<OrdersService>(OrdersService);
  });

  describe('cancelOrder', () => {
    const order = {
      id: 'o1',
      userId: 'u1',
      restaurantId: 'r1',
      status: 'EN_ATTENTE',
      total: 5000,
      items: [{ id: 'it1' }],
      restaurant: {},
    };

    it('Forbidden si la commande n’appartient pas au client', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'u1' });
      prisma.order.findUnique.mockResolvedValue({ ...order, userId: 'autre' });
      await expect(service.cancelOrder('o1', 'uid')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('annule via state machine, restaure le stock en transaction et émet order.cancelled', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'u1' });
      prisma.order.findUnique.mockResolvedValue(order);
      tx.order.update.mockResolvedValue({ id: 'o1', status: 'ANNULER' });

      const res = await service.cancelOrder('o1', 'uid');

      expect(stateMachine.assertTransition).toHaveBeenCalledWith('EN_ATTENTE', 'ANNULER', 'CLIENT');
      expect(stockService.restoreInTransaction).toHaveBeenCalledWith(tx, order.items);
      expect(eventEmitter.emit).toHaveBeenCalledWith('order.cancelled', expect.anything());
      expect(res).toEqual({ id: 'o1', status: 'ANNULER' });
    });
  });

  describe('updateOrderStatusByRestaurateur', () => {
    it('Forbidden si l’utilisateur n’est ni RESTAURATEUR ni ADMIN', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'c1', role: 'CLIENT' });
      await expect(
        service.updateOrderStatusByRestaurateur('o1', 'uid', 'EN_PREPARATION' as any),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('valide la transition, met à jour et émet order.status.updated', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'r1', role: 'RESTAURATEUR' });
      prisma.order.findUnique.mockResolvedValue({
        id: 'o1',
        status: 'PAYER',
        userId: 'c1',
        restaurantId: 'rid',
        restaurant: { ownerId: 'r1', nom: 'Resto' },
      });
      prisma.order.update.mockResolvedValue({
        id: 'o1',
        userId: 'c1',
        restaurantId: 'rid',
        total: 5000,
        subTotal: 4000,
        restaurant: { nom: 'Resto' },
      });

      await service.updateOrderStatusByRestaurateur('o1', 'uid', 'EN_PREPARATION' as any);

      expect(stateMachine.assertTransition).toHaveBeenCalledWith('PAYER', 'EN_PREPARATION', 'RESTAURATEUR');
      expect(eventEmitter.emit).toHaveBeenCalledWith('order.status.updated', expect.anything());
    });
  });

  describe('deleteOrder', () => {
    it('BadRequest si la commande n’est pas ANNULER', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'u1' });
      prisma.order.findUnique.mockResolvedValue({ id: 'o1', userId: 'u1', status: 'EN_ATTENTE' });
      await expect(service.deleteOrder('o1', 'uid')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('soft-delete une commande ANNULER et retourne un message', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'u1' });
      prisma.order.findUnique.mockResolvedValue({ id: 'o1', userId: 'u1', status: 'ANNULER' });
      prisma.order.update.mockResolvedValue({});

      const res = await service.deleteOrder('o1', 'uid');

      expect(prisma.order.update).toHaveBeenCalledWith({
        where: { id: 'o1' },
        data: { deleteCommande: true },
      });
      expect(res).toEqual({ message: 'Commande supprimée avec succès.' });
    });
  });

  describe('reorderFromPreviousOrder', () => {
    it('NotFound si la commande est introuvable', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'u1', cart: { id: 'cart1' } });
      prisma.order.findUnique.mockResolvedValue(null);
      await expect(
        service.reorderFromPreviousOrder('o1', 'uid'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('ajoute les items au panier et retourne un résumé', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'u1', cart: { id: 'cart1' } });
      prisma.order.findUnique.mockResolvedValue({
        id: 'o1',
        userId: 'u1',
        restaurantId: 'r1',
        restaurant: { id: 'r1', nom: 'Resto' },
        items: [
          {
            productId: 'p1',
            variant: 'Normal',
            quantite: 2,
            product: { id: 'p1', nom: 'Plat', restaurantId: 'r1', variants: [{ id: 'v1', label: 'Normal' }] },
          },
        ],
      });
      prisma.cartItem.findMany.mockResolvedValue([]); // panier vide
      prisma.cartItem.findFirst.mockResolvedValue(null);
      prisma.cartItem.create.mockResolvedValue({});
      prisma.cart.findUnique.mockResolvedValue({ id: 'cart1', items: [] });

      const res = await service.reorderFromPreviousOrder('o1', 'uid');

      expect(prisma.cartItem.create).toHaveBeenCalledWith({
        data: { cartId: 'cart1', productId: 'p1', variantId: 'v1', quantite: 2 },
      });
      expect(res.summary).toEqual({ totalAdded: 1, totalUnavailable: 0, totalErrors: 0 });
    });
  });
});
