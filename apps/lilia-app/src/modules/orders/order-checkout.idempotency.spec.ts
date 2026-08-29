import { Test, TestingModule } from '@nestjs/testing';
import { ConflictException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ConfigService } from '@nestjs/config';
import { getRedisConnectionToken } from '@nestjs-modules/ioredis';

import { OrderCheckoutService } from './order-checkout.service';
import { PrismaService } from '../../prisma/prisma.service';
import { StockService } from './stock.service';
import { OrderValidatorService } from './order-validator.service';
import { OrderCalculatorService } from './order-calculator.service';
import { PromoService } from '../promo/promo.service';
import { PlatformSettingsService } from '../platform-settings/platform-settings.service';
import { PreorderValidatorService } from '../vendors/preorder-validator.service';
import { QuartiersService } from '../quartiers/quartiers.service';
import { OutboxService } from '../outbox/outbox.service';

/**
 * Garde d'idempotence du checkout.
 *
 * L'implémentation historique lisait la clé au début et ne l'écrivait qu'après
 * la transaction : deux requêtes concurrentes portant la même clé lisaient
 * toutes deux un cache vide et créaient deux commandes. La réservation `SET NX`
 * ferme cette fenêtre — ces tests la verrouillent.
 */
describe('OrderCheckoutService — idempotence', () => {
  let service: OrderCheckoutService;

  const tx = {
    order: { create: jest.fn() },
    user: { update: jest.fn() },
    loyaltyTransaction: { create: jest.fn() },
    cartItem: { deleteMany: jest.fn() },
    $executeRaw: jest.fn(),
  };

  const createdOrder = {
    id: 'o1',
    userId: 'u1',
    restaurantId: 'resto1',
    total: 11800,
    items: [{ id: 'it1' }],
    restaurant: { nom: 'Resto' },
  };

  const prisma = {
    user: { findUnique: jest.fn() },
    adresses: { findUnique: jest.fn() },
    order: { count: jest.fn() },
    $transaction: jest.fn(async (cb: (t: typeof tx) => unknown) => cb(tx)),
  };
  const validator = {
    validateAndGetUser: jest.fn(),
    validateCartNotEmpty: jest.fn(),
    validateSameRestaurant: jest.fn(),
    validateDeliveryAddress: jest.fn(),
    validateRestaurantOpen: jest.fn(),
    validateStock: jest.fn(),
    validateMinimumOrderAmount: jest.fn(),
  };
  const preorderValidator = {
    validatePreorderForCart: jest.fn(),
    validateDailyCapacity: jest.fn(),
  };
  const calculator = {
    calculate: jest.fn(),
    buildOrderItemSnapshots: jest.fn(),
  };
  const promoService = { validateCode: jest.fn(), applyCode: jest.fn() };
  const stockService = { decrementInTransaction: jest.fn() };
  const platformSettings = { getSettings: jest.fn() };
  const eventEmitter = { emit: jest.fn() };
  const redis = {
    set: jest.fn(),
    get: jest.fn(),
    setex: jest.fn(),
    del: jest.fn(),
  };

  const baseDto = {
    adresseId: 'a1',
    paymentMethod: 'MTN_MOMO',
    isDelivery: true,
  } as never;

  beforeEach(async () => {
    jest.clearAllMocks();

    validator.validateAndGetUser.mockResolvedValue({
      id: 'u1',
      cart: { id: 'cart1', items: [{ id: 'ci1', quantite: 1 }] },
    });
    validator.validateSameRestaurant.mockReturnValue('resto1');
    validator.validateStock.mockResolvedValue(undefined);
    validator.validateDeliveryAddress.mockResolvedValue('Adresse 1');
    validator.validateRestaurantOpen.mockResolvedValue({
      id: 'resto1',
      nom: 'Resto',
      fixedDeliveryFee: 1000,
      deliveryPriceMode: 'FIXED',
      minimumOrderAmount: 0,
    });
    calculator.calculate.mockReturnValue({
      subTotal: 10000,
      deliveryFee: 1000,
      serviceFee: 800,
    });
    calculator.buildOrderItemSnapshots.mockReturnValue([]);
    platformSettings.getSettings.mockResolvedValue({
      serviceFeePercent: 8,
      loyaltyMinRedemption: 100,
      loyaltyPointValueXaf: 5,
      referrerBonusPoints: 500,
      referredBonusPoints: 200,
    });
    prisma.user.findUnique.mockResolvedValue({
      loyaltyPoints: 0,
      referredByCode: null,
      referralRewarded: true,
    });
    tx.order.create.mockResolvedValue(createdOrder);
    redis.setex.mockResolvedValue('OK');
    redis.del.mockResolvedValue(1);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        {
          provide: OutboxService,
          useValue: {
            enqueueInTransaction: jest.fn().mockResolvedValue('outbox-1'),
            markSent: jest.fn().mockResolvedValue(undefined),
          },
        },
        OrderCheckoutService,
        { provide: PrismaService, useValue: prisma },
        { provide: OrderValidatorService, useValue: validator },
        { provide: PreorderValidatorService, useValue: preorderValidator },
        { provide: OrderCalculatorService, useValue: calculator },
        { provide: PromoService, useValue: promoService },
        { provide: StockService, useValue: stockService },
        { provide: PlatformSettingsService, useValue: platformSettings },
        { provide: EventEmitter2, useValue: eventEmitter },
        { provide: QuartiersService, useValue: {} },
        {
          provide: ConfigService,
          useValue: {
            get: (k: string) => (k === 'REDIS_URL' ? 'redis://x' : undefined),
          },
        },
        { provide: getRedisConnectionToken(), useValue: redis },
      ],
    }).compile();

    service = module.get(OrderCheckoutService);
  });

  it('réserve la clé en SET NX AVANT de créer la commande', async () => {
    redis.set.mockResolvedValue('OK');

    await service.createOrderFromCart('uid', baseDto, 'key-1');

    expect(redis.set).toHaveBeenCalledWith(
      'idempotency:uid:key-1',
      '__pending__',
      'EX',
      120,
      'NX',
    );
    // La réservation précède la transaction — c'est tout l'objet du correctif.
    expect(redis.set.mock.invocationCallOrder[0]).toBeLessThan(
      prisma.$transaction.mock.invocationCallOrder[0],
    );
    expect(redis.setex).toHaveBeenCalledWith(
      'idempotency:uid:key-1',
      3600,
      expect.stringContaining('Commande créée avec succès'),
    );
  });

  it('rejette en 409 une requête concurrente pendant le traitement', async () => {
    redis.set.mockResolvedValue(null); // clé déjà prise
    redis.get.mockResolvedValue('__pending__');

    await expect(
      service.createOrderFromCart('uid', baseDto, 'key-1'),
    ).rejects.toThrow(ConflictException);

    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('rejoue la réponse cachée sur un retry légitime', async () => {
    const cached = {
      message: 'Commande créée avec succès.',
      data: createdOrder,
    };
    redis.set.mockResolvedValue(null);
    redis.get.mockResolvedValue(JSON.stringify(cached));

    const result = await service.createOrderFromCart('uid', baseDto, 'key-1');

    expect(result).toEqual(cached);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('libère la réservation si le checkout échoue', async () => {
    redis.set.mockResolvedValue('OK');
    validator.validateStock.mockRejectedValue(new Error('stock épuisé'));

    await expect(
      service.createOrderFromCart('uid', baseDto, 'key-1'),
    ).rejects.toThrow('stock épuisé');

    // Sans ça, le client resterait bloqué en 409 pendant 2 min sur une
    // commande qui n'a jamais été créée.
    expect(redis.del).toHaveBeenCalledWith('idempotency:uid:key-1');
    expect(redis.setex).not.toHaveBeenCalled();
  });

  it('dégrade en best-effort si Redis est indisponible', async () => {
    redis.set.mockRejectedValue(new Error('Redis down'));

    const result = await service.createOrderFromCart('uid', baseDto, 'key-1');

    // Une panne Redis ne doit pas fermer la caisse.
    expect(result).toEqual({
      message: 'Commande créée avec succès.',
      data: createdOrder,
    });
  });
});
