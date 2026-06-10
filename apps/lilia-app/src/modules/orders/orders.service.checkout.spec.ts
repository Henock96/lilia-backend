import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
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
import { StockService } from './stock.service';
import { OrderValidatorService } from './order-validator.service';
import { OrderCalculatorService } from './order-calculator.service';
import { PromoService } from '../promo/promo.service';
import { PlatformSettingsService } from '../platform-settings/platform-settings.service';
import { PreorderValidatorService } from '../vendors/preorder-validator.service';
import { QuartiersService } from '../quartiers/quartiers.service';

/**
 * Tests de CARACTÉRISATION de createOrderFromCart (le checkout) — LIL-134.
 *
 * Fige le comportement observable AVANT extraction d'un OrderCheckoutService :
 * orchestration validators → calcul → promo → fidélité → transaction (création
 * commande + applyCode + points + stock + vidage panier) → event order.created.
 *
 * Note : la branche idempotency (Redis) n'est pas couverte ici — `redis` est null
 * sans REDIS_URL (config mock). Caractérisée séparément le jour où Redis sera
 * injecté proprement.
 */
describe('OrdersService.createOrderFromCart (caractérisation — checkout)', () => {
  let service: OrdersService;

  // ─── tx simulé pour prisma.$transaction(cb) ──────────────────────────────
  const tx = {
    order: { create: jest.fn() },
    user: { update: jest.fn() },
    loyaltyTransaction: { create: jest.fn() },
    cartItem: { deleteMany: jest.fn() },
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

  const SETTINGS = {
    serviceFeePercent: 8,
    loyaltyMinRedemption: 100,
    loyaltyPointValueXaf: 5,
    loyaltyPointsPer100Xaf: 1,
    referrerBonusPoints: 500,
    referredBonusPoints: 200,
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    // Défauts "happy path"
    validator.validateAndGetUser.mockResolvedValue({
      id: 'u1',
      cart: { id: 'cart1', items: [{ id: 'ci1', quantite: 1 }] },
    });
    validator.validateSameRestaurant.mockReturnValue('resto1');
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
    calculator.buildOrderItemSnapshots.mockReturnValue([
      { productId: 'p1', menuId: null, quantite: 1, prix: 10000, variant: '', variantId: null, snapshotPrice: 10000 },
    ]);
    platformSettings.getSettings.mockResolvedValue(SETTINGS);
    // findUnique couvre loyalty (loyaltyPoints) ET handleReferralReward (return early)
    prisma.user.findUnique.mockResolvedValue({
      loyaltyPoints: 0,
      referredByCode: null,
      referralRewarded: true,
    });
    tx.order.create.mockResolvedValue(createdOrder);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OrdersService,
        OrderCheckoutService, // service réel : OrdersService y délègue le checkout
        OrderQueryService, // requis par OrdersService (lectures) — non sollicité ici
        OrderLifecycleService, // requis par OrdersService — non sollicité ici
        OrderReorderService, // requis par OrdersService — non sollicité ici
        { provide: PrismaService, useValue: prisma },
        { provide: OrderValidatorService, useValue: validator },
        { provide: PreorderValidatorService, useValue: preorderValidator },
        { provide: OrderCalculatorService, useValue: calculator },
        { provide: PromoService, useValue: promoService },
        { provide: StockService, useValue: stockService },
        { provide: PlatformSettingsService, useValue: platformSettings },
        { provide: EventEmitter2, useValue: eventEmitter },
        { provide: ConfigService, useValue: { get: () => undefined } },
        { provide: PaginationService, useValue: {} },
        { provide: OrderStateMachine, useValue: {} },
        { provide: QuartiersService, useValue: {} },
      ],
    }).compile();

    service = module.get<OrdersService>(OrdersService);
  });

  const baseDto = {
    adresseId: 'a1',
    paymentMethod: 'MTN_MOMO',
    isDelivery: true,
  } as any;

  it('happy path : crée la commande, retourne { message, data } et émet order.created', async () => {
    const res = await service.createOrderFromCart('uid', baseDto);

    expect(res).toEqual({ message: 'Commande créée avec succès.', data: createdOrder });
    expect(eventEmitter.emit).toHaveBeenCalledWith('order.created', expect.anything());

    const data = tx.order.create.mock.calls[0][0].data;
    expect(data.subTotal).toBe(10000);
    expect(data.deliveryFee).toBe(1000);
    expect(data.serviceFee).toBe(800);
    expect(data.discountAmount).toBe(0);
    expect(data.total).toBe(11800);
    expect(data.status).toBe('EN_ATTENTE');
    expect(tx.cartItem.deleteMany).toHaveBeenCalledWith({ where: { cartId: 'cart1' } });
    expect(stockService.decrementInTransaction).toHaveBeenCalled();
  });

  it('livraison sans adresseId → BadRequestException, pas de transaction', async () => {
    await expect(
      service.createOrderFromCart('uid', { paymentMethod: 'MTN_MOMO', isDelivery: true } as any),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('promo : valide le code, applyCode dans la transaction, discountAmount répercuté', async () => {
    promoService.validateCode.mockResolvedValue({
      promoCodeId: 'pc1',
      discountAmount: 2000,
      newDeliveryFee: 1000,
    });

    await service.createOrderFromCart('uid', { ...baseDto, promoCode: 'PROMO' });

    expect(promoService.validateCode).toHaveBeenCalledWith('PROMO', 'u1', 'resto1', 10000, 1000);
    expect(promoService.applyCode).toHaveBeenCalledWith(tx, 'pc1', 'u1', 'o1', 2000);
    const data = tx.order.create.mock.calls[0][0].data;
    expect(data.discountAmount).toBe(2000);
    expect(data.promoCodeId).toBe('pc1');
    expect(data.total).toBe(9800); // 11800 - 2000
  });

  it('points fidélité : plafonne au solde, décrémente et trace dans la transaction', async () => {
    prisma.user.findUnique.mockResolvedValue({
      loyaltyPoints: 1000,
      referredByCode: null,
      referralRewarded: true,
    });

    await service.createOrderFromCart('uid', { ...baseDto, useLoyaltyPoints: true });

    // 1000 pts × 5 XAF = 5000 de réduction (plafonné au solde, < montant dû 11800)
    expect(tx.user.update).toHaveBeenCalledWith({
      where: { id: 'u1' },
      data: { loyaltyPoints: { decrement: 1000 } },
    });
    expect(tx.loyaltyTransaction.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ points: -1000 }) }),
    );
    const data = tx.order.create.mock.calls[0][0].data;
    expect(data.discountAmount).toBe(5000);
    expect(data.total).toBe(6800); // 11800 - 5000
  });
});
