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
import { OrderTransitionService } from './order-transition.service';
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
import { LoyaltyService } from '../loyalty/loyalty.service';
import { ReferralService } from '../users/referral.service';
import { RefundsService } from '../refunds/refunds.service';
import { AdminAuditService } from '../admin-audit/admin-audit.service';
import { OutboxService } from '../outbox/outbox.service';
import { DeliveryPricingService } from '../delivery-pricing/delivery-pricing.service';
import { cartLine } from '../modifiers/testing/cart-line.fixture';

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
    // P0-4 : toute transition de statut écrit sa ligne d'historique dans la
    // MÊME transaction. Le client de transaction doit donc l'exposer.
    orderHistory: { create: jest.fn() },
    order: { create: jest.fn() },
    user: { update: jest.fn() },
    loyaltyTransaction: { create: jest.fn() },
    cartItem: { deleteMany: jest.fn(), findMany: jest.fn() },
    // Verrou `SELECT … FOR UPDATE` sur le panier (fix F-11).
    $queryRaw: jest.fn(),
    // Décrément conditionnel des points de fidélité (tagged template SQL).
    // Retourne le nombre de lignes affectées : 1 = solde suffisant, 0 = course perdue.
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
    $transaction: jest.fn(async (cb: (t: typeof tx) => unknown) => cb(tx)),
  };
  const validator = {
    validateAndGetUser: jest.fn(),
    validateCartNotEmpty: jest.fn(),
    validateSameRestaurant: jest.fn(),
    validateRestaurantOpen: jest.fn(),
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
  // Tarification plateforme (F3-02). `null` = mode historique VENDOR_LEGACY.
  const deliveryPricing = { quoteForVendor: jest.fn() };

  const SETTINGS = {
    serviceFeePercent: 8,
    restaurantCommissionPercent: 10,
    loyaltyMinRedemption: 100,
    loyaltyPointValueXaf: 5,
    loyaltyPointsPer100Xaf: 1,
    referrerBonusPoints: 500,
    referredBonusPoints: 200,
  };

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

    // Défauts "happy path"
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
      {
        productId: 'p1',
        menuId: null,
        quantite: 1,
        prix: 10000,
        variant: '',
        variantId: null,
        snapshotPrice: 10000,
        optionsTotalXaf: 0,
        options: [],
      },
    ]);
    platformSettings.getSettings.mockResolvedValue(SETTINGS);
    // findUnique couvre loyalty (loyaltyPoints) ET handleReferralReward (return early)
    prisma.user.findUnique.mockResolvedValue({
      loyaltyPoints: 0,
      referredByCode: null,
      referralRewarded: true,
    });
    tx.order.create.mockResolvedValue(createdOrder);
    tx.$executeRaw.mockResolvedValue(1); // solde suffisant par défaut
    deliveryPricing.quoteForVendor.mockResolvedValue(null);

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
        { provide: ConfigService, useValue: { get: () => undefined } },
        { provide: PaginationService, useValue: {} },
        { provide: OrderStateMachine, useValue: {} },
        OrderTransitionService,
        { provide: QuartiersService, useValue: {} },
        {
          provide: DeliveryDestinationService,
          useValue: destinationService,
        },
        { provide: DeliveryPricingService, useValue: deliveryPricing },
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
    const res = await service.createOrderFromCart('uid', baseDto, 'idem-key-1');

    expect(res).toEqual({
      message: 'Commande créée avec succès.',
      data: createdOrder,
    });
    expect(eventEmitter.emit).toHaveBeenCalledWith(
      'order.created',
      expect.anything(),
    );

    const data = tx.order.create.mock.calls[0][0].data;
    expect(data.subTotal).toBe(10000);
    expect(data.deliveryFee).toBe(1000);
    expect(data.serviceFee).toBe(800);
    expect(data.discountAmount).toBe(0);
    expect(data.total).toBe(11800);
    expect(data.status).toBe('EN_ATTENTE');
    expect(tx.cartItem.deleteMany).toHaveBeenCalledWith({
      where: { cartId: 'cart1', id: { in: ['ci1'] } },
    });
    expect(stockService.decrementInTransaction).toHaveBeenCalled();
  });

  /**
   * Fix F-11 — un panier ne se paie qu'une fois, arbitré par la base.
   *
   * Le verrou `FOR UPDATE` est posé AVANT toute écriture ; sous verrou, le
   * panier relu doit être celui du calcul. Sinon 409 et rien n'est écrit : pas
   * de commande, pas de stock, pas de points.
   */
  describe('double checkout (F-11)', () => {
    it('verrouille le panier avant la moindre écriture', async () => {
      await service.createOrderFromCart('uid', baseDto, 'key-f11-a');
      expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
      const lockOrder = tx.$queryRaw.mock.invocationCallOrder[0];
      expect(lockOrder).toBeLessThan(
        tx.order.create.mock.invocationCallOrder[0],
      );
    });

    it('panier déjà commandé par un checkout concurrent → 409, aucune commande', async () => {
      tx.cartItem.findMany.mockResolvedValueOnce([]);
      await expect(
        service.createOrderFromCart('uid', baseDto, 'key-f11-b'),
      ).rejects.toThrow(/déjà d’être commandé/);
      expect(tx.order.create).not.toHaveBeenCalled();
      expect(stockService.decrementInTransaction).not.toHaveBeenCalled();
      expect(tx.cartItem.deleteMany).not.toHaveBeenCalled();
    });

    it('panier modifié pendant la validation (quantité) → 409', async () => {
      tx.cartItem.findMany.mockResolvedValueOnce([{ id: 'ci1', quantite: 3 }]);
      await expect(
        service.createOrderFromCart('uid', baseDto, 'key-f11-c'),
      ).rejects.toThrow(/a changé pendant la validation/);
      expect(tx.order.create).not.toHaveBeenCalled();
    });

    it('ligne ajoutée depuis un autre appareil → 409', async () => {
      tx.cartItem.findMany.mockResolvedValueOnce([
        { id: 'ci1', quantite: 1 },
        { id: 'ci-autre', quantite: 1 },
      ]);
      await expect(
        service.createOrderFromCart('uid', baseDto, 'key-f11-d'),
      ).rejects.toThrow(/a changé pendant la validation/);
    });
  });

  /**
   * Le checkout est le SEUL endroit qui résout « quel taux de commission ? ».
   *
   * Il retombait sur `0` quand le vendeur n'en portait pas, pendant que
   * `RestaurantPayoutService` retombait, lui, sur le taux plateforme. Les deux
   * replis se contredisaient : les 124 commandes de production portaient
   * `commissionPercent = 0` alors que les reversements prélevaient 10 %.
   *
   * Le reversement ne résout plus rien — il lit ce snapshot. Le repli doit donc
   * être ici, et juste, sans quoi `PlatformSettings.restaurantCommissionPercent`
   * deviendrait un réglage sans effet.
   */
  describe('commission vendeur — le repli plateforme est résolu ICI, une seule fois', () => {
    it('fige le taux du vendeur quand il en porte un', async () => {
      validator.validateRestaurantOpen.mockResolvedValue({
        id: 'resto1',
        nom: 'Resto',
        fixedDeliveryFee: 1000,
        deliveryPriceMode: 'FIXED',
        minimumOrderAmount: 0,
        commissionPercent: 12,
      });

      await service.createOrderFromCart('uid', baseDto, 'idem-key-1');

      expect(calculator.calculate).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.anything(),
        8,
        12,
      );
    });

    it('retombe sur le taux plateforme quand le vendeur n’en porte pas', async () => {
      // Le vendeur nominal du fixture n'a pas de `commissionPercent`.
      await service.createOrderFromCart('uid', baseDto, 'idem-key-1');

      expect(calculator.calculate).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.anything(),
        8,
        10, // et surtout PAS 0, ni `undefined`
      );
    });

    it('un taux vendeur à 0 % reste 0 % — ce n’est pas une absence de taux', async () => {
      validator.validateRestaurantOpen.mockResolvedValue({
        id: 'resto1',
        nom: 'Resto',
        fixedDeliveryFee: 1000,
        deliveryPriceMode: 'FIXED',
        minimumOrderAmount: 0,
        commissionPercent: 0,
      });

      await service.createOrderFromCart('uid', baseDto, 'idem-key-1');

      expect(calculator.calculate).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.anything(),
        8,
        0, // `??` et non `||` : 0 est une valeur, pas un vide
      );
    });
  });

  it('livraison sans adresseId → BadRequestException, pas de transaction', async () => {
    await expect(
      service.createOrderFromCart(
        'uid',
        { paymentMethod: 'MTN_MOMO', isDelivery: true } as any,
        'idem-key-1',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('promo : valide le code, applyCode dans la transaction, discountAmount répercuté', async () => {
    promoService.validateCode.mockResolvedValue({
      promoCodeId: 'pc1',
      discountAmount: 2000,
      newDeliveryFee: 1000,
    });

    await service.createOrderFromCart(
      'uid',
      {
        ...baseDto,
        promoCode: 'PROMO',
      },
      'idem-key-1',
    );

    expect(promoService.validateCode).toHaveBeenCalledWith(
      'PROMO',
      'u1',
      'resto1',
      10000,
      1000,
    );
    expect(promoService.applyCode).toHaveBeenCalledWith(
      tx,
      'pc1',
      'u1',
      'o1',
      2000,
    );
    const data = tx.order.create.mock.calls[0][0].data;
    expect(data.discountAmount).toBe(2000);
    expect(data.promoCodeId).toBe('pc1');
    expect(data.total).toBe(9800); // 11800 - 2000
  });

  /**
   * L'assiette qui rémunère le livreur.
   *
   * `deliveryFee` porte le tarif APRÈS remise : un code FREE_DELIVERY le met à
   * 0. Payer le livreur dessus lui ferait porter une campagne marketing qu'il
   * n'a pas décidée — il a roulé. Même règle que pour le vendeur, dont le
   * reversement ignore déjà les remises.
   *
   * Le montant brut n'était persisté nulle part : il n'était reconstructible
   * que par une soustraction à trois termes sur deux tables. Un chemin de
   * paiement ne repose pas sur une reconstruction.
   */
  describe('deliveryFeeGross — le tarif AVANT remise', () => {
    it('sans promo, brut et net coïncident', async () => {
      await service.createOrderFromCart('uid', baseDto, 'idem-key-1');

      const data = tx.order.create.mock.calls[0][0].data;
      expect(data.deliveryFeeGross).toBe(1000);
      expect(data.deliveryFee).toBe(1000);
    });

    it('livraison offerte : le net tombe à 0, le BRUT reste à 1 000', async () => {
      promoService.validateCode.mockResolvedValue({
        promoCodeId: 'pc-free',
        discountAmount: 0,
        newDeliveryFee: 0, // ce que fait un code FREE_DELIVERY
      });

      await service.createOrderFromCart(
        'uid',
        { ...baseDto, promoCode: 'LIVRAISON_OFFERTE' },
        'idem-key-1',
      );

      const data = tx.order.create.mock.calls[0][0].data;
      expect(data.deliveryFee).toBe(0);
      // C'est CE montant qui rémunérera le livreur.
      expect(data.deliveryFeeGross).toBe(1000);
    });

    it('retrait au comptoir : pas de course, donc pas de tarif', async () => {
      // `OrderCalculatorService.calculate` applique déjà `isDelivery ? fee : 0`.
      // Le mock doit rendre ce que rend le vrai calculateur, sinon le test
      // exigerait du checkout qu'il duplique une règle qui vit ailleurs.
      calculator.calculate.mockReturnValue({
        subTotal: 10000,
        deliveryFee: 0,
        serviceFee: 800,
      });

      await service.createOrderFromCart(
        'uid',
        { ...baseDto, isDelivery: false },
        'idem-key-1',
      );

      const data = tx.order.create.mock.calls[0][0].data;
      expect(data.deliveryFeeGross).toBe(0);
    });
  });

  it('points fidélité : plafonne au solde, décrémente et trace dans la transaction', async () => {
    prisma.user.findUnique.mockResolvedValue({
      loyaltyPoints: 1000,
      referredByCode: null,
      referralRewarded: true,
    });

    await service.createOrderFromCart(
      'uid',
      {
        ...baseDto,
        useLoyaltyPoints: true,
      },
      'idem-key-1',
    );

    // 1000 pts × 5 XAF = 5000 de réduction (plafonné au solde, < montant dû 11800)
    // Le décrément passe par un UPDATE … WHERE conditionnel, pas par tx.user.update.
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
    const [, ...values] = tx.$executeRaw.mock.calls[0];
    expect(values).toEqual([1000, 'u1', 1000]); // n points, userId, garde >= n
    expect(tx.user.update).not.toHaveBeenCalled();
    expect(tx.loyaltyTransaction.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ points: -1000 }),
      }),
    );
    const data = tx.order.create.mock.calls[0][0].data;
    expect(data.discountAmount).toBe(5000);
    expect(data.total).toBe(6800); // 11800 - 5000
  });

  it("points fidélité : checkout concurrent perdant → BadRequestException, rien n'est tracé", async () => {
    // Scénario : deux checkouts simultanés du même user ont lu le même solde de
    // 1000 pts hors transaction. Le premier a déjà décrémenté ; pour le second
    // le UPDATE … WHERE "loyaltyPoints" >= 1000 n'affecte aucune ligne.
    prisma.user.findUnique.mockResolvedValue({
      loyaltyPoints: 1000,
      referredByCode: null,
      referralRewarded: true,
    });
    tx.$executeRaw.mockResolvedValue(0);

    await expect(
      service.createOrderFromCart(
        'uid',
        {
          ...baseDto,
          useLoyaltyPoints: true,
        },
        'idem-key-1',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);

    // La transaction remonte l'exception → rollback : aucune trace de fidélité,
    // pas de décrément de stock, panier intact.
    expect(tx.loyaltyTransaction.create).not.toHaveBeenCalled();
    expect(stockService.decrementInTransaction).not.toHaveBeenCalled();
    expect(tx.cartItem.deleteMany).not.toHaveBeenCalled();
    expect(eventEmitter.emit).not.toHaveBeenCalledWith(
      'order.created',
      expect.anything(),
    );
  });

  /**
   * F3-02 — la plateforme fixe le prix de base de la course.
   *
   * `deliveryFeeGross` est l'assiette de la paie livreur (35 % / 65 % selon
   * son statut, décision D3) : il doit valoir le prix de BASE, jamais ce que
   * paie le client après la part offerte par le vendeur.
   */
  describe('tarification plateforme (F3-02)', () => {
    const QUOTE = {
      tariffVersion: 4,
      baseFeeXaf: 1500,
      subsidyXaf: 300,
      customerFeeXaf: 1200,
      distanceKm: 4.2,
      basis: 'BAND' as const,
    };

    beforeEach(() => {
      platformSettings.getSettings.mockResolvedValue({
        ...SETTINGS,
        deliveryPricingMode: 'PLATFORM',
      });
      deliveryPricing.quoteForVendor.mockResolvedValue(QUOTE);
      calculator.calculate.mockImplementation(
        (_items: unknown, fee: number) => ({
          subTotal: 10000,
          deliveryFee: fee,
          serviceFee: 800,
        }),
      );
    });

    it('le client paie le prix de base moins la part offerte par le vendeur', async () => {
      await service.createOrderFromCart('uid', baseDto, 'key-f302-a');
      const data = tx.order.create.mock.calls[0][0].data;
      expect(data.deliveryFee).toBe(1200);
      expect(data.total).toBe(10000 + 1200 + 800);
    });

    it('la paie livreur repose sur le prix de BASE, pas sur le prix client', async () => {
      await service.createOrderFromCart('uid', baseDto, 'key-f302-b');
      expect(tx.order.create.mock.calls[0][0].data.deliveryFeeGross).toBe(1500);
    });

    it('fige la version de grille, la distance, la base et la subvention', async () => {
      await service.createOrderFromCart('uid', baseDto, 'key-f302-c');
      expect(tx.order.create.mock.calls[0][0].data).toMatchObject({
        deliveryTariffVersion: 4,
        deliveryDistanceKm: 4.2,
        deliveryFeeBaseXaf: 1500,
        vendorDeliverySubsidyXaf: 300,
      });
    });

    it('le devis reçoit le sous-total du panier et la destination résolue', async () => {
      destinationService.resolveForAddress.mockResolvedValueOnce({
        address: 'x',
        latitude: -4.2454,
        longitude: 15.2629,
        precision: 'EXACT',
        quartierId: 'q-moungali',
        quartierNom: 'Moungali',
        landmark: null,
      });
      await service.createOrderFromCart('uid', baseDto, 'key-f302-d');
      expect(deliveryPricing.quoteForVendor).toHaveBeenCalledWith(
        expect.objectContaining({
          subTotalXaf: 10000,
          destination: {
            quartierId: 'q-moungali',
            latitude: -4.2454,
            longitude: 15.2629,
          },
        }),
      );
    });

    it('le prix du vendeur (fixe ou zone) n’est plus lu', async () => {
      validator.validateRestaurantOpen.mockResolvedValue({
        id: 'resto1',
        nom: 'Resto',
        fixedDeliveryFee: 0,
        deliveryPriceMode: 'ZONE_BASED',
        minimumOrderAmount: 0,
      });
      destinationService.resolveForAddress.mockResolvedValueOnce({
        address: 'x',
        latitude: null,
        longitude: null,
        precision: 'UNKNOWN',
        quartierId: 'q-1',
        quartierNom: 'Q',
        landmark: null,
      });
      await service.createOrderFromCart('uid', baseDto, 'key-f302-e');
      // `quartiersService` est un objet vide : l'appeler lèverait.
      expect(tx.order.create.mock.calls[0][0].data.deliveryFee).toBe(1200);
    });

    it('retrait au comptoir : aucun devis, aucune livraison facturée', async () => {
      await service.createOrderFromCart(
        'uid',
        { ...baseDto, isDelivery: false },
        'key-f302-f',
      );
      expect(deliveryPricing.quoteForVendor).not.toHaveBeenCalled();
      expect(tx.order.create.mock.calls[0][0].data).toMatchObject({
        deliveryTariffVersion: null,
        vendorDeliverySubsidyXaf: 0,
      });
    });
  });

  it('mode historique : la base payée au livreur reste le prix calculé, rien de figé', async () => {
    await service.createOrderFromCart('uid', baseDto, 'key-legacy');
    expect(tx.order.create.mock.calls[0][0].data).toMatchObject({
      deliveryFeeGross: 1000,
      deliveryTariffVersion: null,
      deliveryFeeBaseXaf: null,
      vendorDeliverySubsidyXaf: 0,
    });
  });
});
