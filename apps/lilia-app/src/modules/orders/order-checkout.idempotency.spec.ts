import { Test, TestingModule } from '@nestjs/testing';
import { ConflictException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { OrderCheckoutService } from './order-checkout.service';
import { PrismaService } from '../../prisma/prisma.service';
import { StockService } from './stock.service';
import { StockSignalService } from './stock-signal.service';
import { VendorOffersService } from '../vendor-offers/vendor-offers.service';
import { CartService } from '../cart/cart.service';
import { OrderValidatorService } from './order-validator.service';
import { OrderCalculatorService } from './order-calculator.service';
import { PromoService } from '../promo/promo.service';
import { PlatformSettingsService } from '../platform-settings/platform-settings.service';
import { PreorderValidatorService } from '../vendors/preorder-validator.service';
import { QuartiersService } from '../quartiers/quartiers.service';
import { DeliveryDestinationService } from './delivery-destination.service';
import { DeliveryPricingService } from '../delivery-pricing/delivery-pricing.service';
import { OutboxService } from '../outbox/outbox.service';
import { OrderTransitionService } from './order-transition.service';
import { cartLine } from '../modifiers/testing/cart-line.fixture';

/**
 * Garde d'idempotence du checkout, portée par la base (durcissement lot 4).
 *
 * La clé est écrite sur la commande, sous l'index unique
 * `(userId, idempotencyKey)` ; un rejeu relit la commande. Ces tests figent le
 * contrat du service ; la course réelle de deux requêtes est rejouée sur
 * PostgreSQL par `test/integration/checkout-idempotency.int-spec.ts`.
 */
describe('OrderCheckoutService — idempotence', () => {
  let service: OrderCheckoutService;

  const tx = {
    // P0-4 : toute transition de statut écrit sa ligne d'historique dans la
    // MÊME transaction. Le client de transaction doit donc l'exposer.
    orderHistory: { create: jest.fn() },
    order: { create: jest.fn() },
    user: { update: jest.fn() },
    loyaltyTransaction: { create: jest.fn() },
    cartItem: { deleteMany: jest.fn(), findMany: jest.fn() },
    // Verrou `SELECT … FOR UPDATE` sur le panier (fix F-11).
    $queryRaw: jest.fn(),
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
    order: { count: jest.fn(), findFirst: jest.fn() },
    $transaction: jest.fn(async (cb: (t: typeof tx) => unknown) => cb(tx)),
  };
  const validator = {
    validateAndGetUser: jest.fn(),
    validateCartNotEmpty: jest.fn(),
    validateSameRestaurant: jest.fn(),
    validateRestaurantOpen: jest.fn(),
    validateServiceMode: jest.fn(),
    validateScheduledNotClosed: jest.fn(),
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
  const stockService = {
    decrementInTransaction: jest
      .fn()
      .mockResolvedValue({ limitedProductIds: [], movements: [] }),
    recordReservation: jest.fn(),
  };
  const platformSettings = { getSettings: jest.fn() };
  const eventEmitter = { emit: jest.fn() };
  // Destination résolue côté serveur : les specs de checkout n'ont pas à
  // rejouer la logique de repli (elle a sa propre suite), seulement à fournir
  // une destination plausible.
  const destinationService = {
    resolveForAddress: jest.fn(),
  };
  const baseDto = {
    adresseId: 'a1',
    paymentMethod: 'MTN_MOMO',
    isDelivery: true,
  } as never;

  beforeEach(async () => {
    jest.clearAllMocks();
    // Sous verrou, le panier relu est par défaut celui qui a servi au calcul :
    // aucun checkout concurrent. Les cas de course le surchargent.
    tx.cartItem.findMany.mockImplementation(async () => {
      const user =
        await validator.validateAndGetUser.mock.results[
          validator.validateAndGetUser.mock.results.length - 1
        ]?.value;
      return (user?.cart?.items ?? []).map(
        ({ id, quantite }: { id: string; quantite: number }) => ({
          id,
          quantite,
        }),
      );
    });

    validator.validateAndGetUser.mockResolvedValue({
      id: 'u1',
      cart: { id: 'cart1', items: [cartLine({ id: 'ci1', quantite: 1 })] },
    });
    validator.validateSameRestaurant.mockReturnValue('resto1');
    destinationService.resolveForAddress.mockResolvedValue({
      address: 'Adresse 1, Poto-Poto, Brazzaville',
      latitude: -4.274,
      longitude: 15.2678,
      precision: 'EXACT',
      quartierId: null,
      quartierNom: 'Poto-Poto',
      landmark: null,
    });
    validator.validateStock.mockResolvedValue(undefined);
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
    // Par défaut, aucune commande ne porte encore la clé.
    prisma.order.findFirst.mockResolvedValue(null);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        // P0-4 : `Order.status` ne s'écrit plus qu'à travers ce service,
        // qui historise la transition dans la même transaction.
        OrderTransitionService,
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
        { provide: StockSignalService, useValue: { announce: jest.fn() } },
        // F3-11 — aucune offre boutique active dans ces tests.
        {
          provide: VendorOffersService,
          useValue: {
            resolveForCart: jest.fn().mockResolvedValue(null),
            reserveInTransaction: jest.fn(),
            releaseForOrder: jest.fn().mockResolvedValue(0),
          },
        },
        { provide: CartService, useValue: { addMenu: jest.fn() } },
        { provide: PlatformSettingsService, useValue: platformSettings },
        { provide: EventEmitter2, useValue: eventEmitter },
        { provide: QuartiersService, useValue: {} },
        {
          provide: DeliveryDestinationService,
          useValue: destinationService,
        },
        {
          provide: DeliveryPricingService,
          useValue: { quoteForVendor: jest.fn().mockResolvedValue(null) },
        },
      ],
    }).compile();

    service = module.get(OrderCheckoutService);
  });

  it('écrit la clé sur la commande, dans la transaction de création', async () => {
    await service.createOrderFromCart('uid', baseDto, 'key-1');

    expect(tx.order.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ idempotencyKey: 'key-1' }),
      }),
    );
    // La clé est cherchée pour CE client seulement : la même clé tirée par
    // deux clients ne doit jamais rejouer la commande de l'autre.
    expect(prisma.order.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { idempotencyKey: 'key-1', user: { firebaseUid: 'uid' } },
      }),
    );
  });

  it('rejoue la commande existante sans rien recréer', async () => {
    prisma.order.findFirst.mockResolvedValue(createdOrder);

    const result = await service.createOrderFromCart('uid', baseDto, 'key-1');

    expect(result).toEqual({
      message: 'Commande créée avec succès.',
      data: createdOrder,
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(validator.validateAndGetUser).not.toHaveBeenCalled();
  });

  it('convertit en rejeu l’échec d’une requête jumelle qui a perdu la course', async () => {
    // La jumelle a commité pendant que celle-ci attendait le verrou du
    // panier : le panier est vide, le checkout lève 409 — mais une commande
    // porte désormais la clé.
    prisma.order.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(createdOrder);
    prisma.$transaction.mockRejectedValueOnce(
      new ConflictException('Ce panier vient déjà d’être commandé.'),
    );

    const result = await service.createOrderFromCart('uid', baseDto, 'key-1');

    expect(result.data).toBe(createdOrder);
  });

  it('laisse remonter un vrai échec quand aucune commande ne porte la clé', async () => {
    validator.validateStock.mockRejectedValue(new Error('stock épuisé'));

    await expect(
      service.createOrderFromCart('uid', baseDto, 'key-1'),
    ).rejects.toThrow('stock épuisé');
    // Rien n'a été créé : un vrai retry reste possible avec la même clé.
    expect(tx.order.create).not.toHaveBeenCalled();
  });

  it('une relecture qui échoue ne masque pas l’erreur d’origine', async () => {
    prisma.order.findFirst
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error('pool saturé'));
    validator.validateStock.mockRejectedValue(new Error('stock épuisé'));

    await expect(
      service.createOrderFromCart('uid', baseDto, 'key-1'),
    ).rejects.toThrow('stock épuisé');
  });

  it('exige la clé', async () => {
    await expect(
      service.createOrderFromCart('uid', baseDto, '  '),
    ).rejects.toThrow("En-tête 'Idempotency-Key' requis");
    expect(prisma.order.findFirst).not.toHaveBeenCalled();
  });
});
