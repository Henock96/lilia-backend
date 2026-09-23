import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { PaymentEventSource, PayoutStatus, Prisma } from '@prisma/client';

import { RestaurantPayoutService } from './services/restaurant-payout.service';
import { PaymentEventService } from './services/payment-event.service';
import { PaymentProviderRegistry } from './payment-provider.registry';
import { PayoutStateMachine } from './payout-state.machine';
import { PlatformSettingsService } from '../platform-settings/platform-settings.service';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Reversement vendeur — éligibilité, calcul, idempotence, concurrence.
 *
 * La règle que ces tests protègent tient en une phrase : **un vendeur n'est payé
 * qu'une fois, et seulement quand tout est réuni**. Le reste (montant,
 * autorisation, motifs) en découle.
 */
describe('RestaurantPayoutService', () => {
  let service: RestaurantPayoutService;

  const prisma = {
    order: { findUnique: jest.fn(), findUniqueOrThrow: jest.fn() },
    restaurantPayout: {
      create: jest.fn(),
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      updateMany: jest.fn(),
      deleteMany: jest.fn(),
      count: jest.fn(),
      groupBy: jest.fn(),
    },
    incident: { create: jest.fn() },
    refund: { findUnique: jest.fn() },
    // Compte de reversement relu sous verrou (fix F-08).
    restaurant: { findUniqueOrThrow: jest.fn() },
    // Verrou de la ligne `Order` sous lequel naît le reversement (fix F-04).
    $queryRaw: jest.fn(),
    // La transaction reçoit le client lui-même : les assertions sur
    // `restaurantPayout.create` restent valables à l'intérieur.
    $transaction: jest.fn(async (fn: (tx: unknown) => unknown) => fn(prisma)),
  };

  const events = {
    record: jest.fn().mockResolvedValue('evt-1'),
    setOutcome: jest.fn(),
  };
  const eventEmitter = { emit: jest.fn() };

  const payoutProvider = {
    name: 'PAWAPAY',
    supportsCollection: true,
    supportsPayout: true,
    createCollection: jest.fn(),
    getCollectionStatus: jest.fn(),
    createPayout: jest.fn(),
    getPayoutStatus: jest.fn(),
  };

  let payoutSupported = true;
  const registry = {
    currentMode: 'PAWAPAY',
    forNewTransaction: () => payoutProvider,
    forStoredProvider: () => payoutProvider,
    forPayout: () => (payoutSupported ? payoutProvider : null),
  };

  const settings = {
    getSettings: jest
      .fn()
      .mockResolvedValue({ restaurantCommissionPercent: 10 }),
  };

  /** Commande nominale : payée, PRET, vendeur configuré. */
  const readyOrder = (overrides: Record<string, unknown> = {}) => ({
    id: 'o1',
    status: 'PRET',
    subTotal: 5000,
    /**
     * Taux FIGÉ à la commande. C'est lui — et lui seul — qui décide de ce que
     * le vendeur touchera. `restaurant.commissionPercent` ci-dessous décrit ce
     * que portera la PROCHAINE commande, pas celle-ci.
     */
    commissionPercent: 10,
    deliveryFee: 1000,
    serviceFee: 400,
    total: 6400,
    restaurantId: 'r1',
    restaurant: {
      id: 'r1',
      nom: 'Chez Mere Lili',
      ownerId: 'owner-1',
      commissionPercent: null,
      payoutPhoneNumber: '242061234567',
      payoutProvider: 'MTN_MOMO',
    },
    Payment: [{ status: 'SUCCESS', amount: 6400 }],
    refund: null,
    payout: null,
    ...overrides,
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    prisma.$queryRaw.mockResolvedValue([{ status: 'PRET' }]);
    prisma.refund.findUnique.mockResolvedValue(null);
    // Par défaut, le compte relu est celui de la commande, hors délai de carence.
    prisma.restaurant.findUniqueOrThrow.mockImplementation(async () => {
      const order =
        await prisma.order.findUniqueOrThrow.mock.results[
          prisma.order.findUniqueOrThrow.mock.results.length - 1
        ]?.value;
      return {
        payoutPhoneNumber: order?.restaurant?.payoutPhoneNumber ?? null,
        payoutProvider: order?.restaurant?.payoutProvider ?? null,
        payoutVerifiedAt: null,
      };
    });
    payoutSupported = true;
    settings.getSettings.mockResolvedValue({ restaurantCommissionPercent: 10 });
    events.record.mockResolvedValue('evt-1');
    // `openMismatchIncident` chaîne un `.catch` : le mock doit rendre une
    // promesse, sinon on teste un TypeError et non le comportement.
    prisma.incident.create.mockResolvedValue({ id: 'inc-1' });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RestaurantPayoutService,
        PayoutStateMachine,
        { provide: PrismaService, useValue: prisma },
        { provide: PaymentProviderRegistry, useValue: registry },
        { provide: PlatformSettingsService, useValue: settings },
        { provide: PaymentEventService, useValue: events },
        { provide: EventEmitter2, useValue: eventEmitter },
      ],
    }).compile();

    service = module.get(RestaurantPayoutService);
  });

  // ══════════════════════════════════════════════════════════════════════════
  describe('éligibilité', () => {
    it('commande PRET, payée, vendeur configuré → éligible', async () => {
      prisma.order.findUnique.mockResolvedValue(readyOrder());

      const result = await service.checkEligibility('o1');

      expect(result.eligible).toBe(true);
      expect(result.breakdown).toEqual({
        grossAmount: 5000,
        commissionPercent: 10,
        commissionAmount: 500,
        payoutAmount: 4500,
        currency: 'XAF',
      });
    });

    it('commande introuvable → ORDER_NOT_FOUND', async () => {
      prisma.order.findUnique.mockResolvedValue(null);
      const result = await service.checkEligibility('inconnue');
      expect(result).toMatchObject({
        eligible: false,
        code: 'ORDER_NOT_FOUND',
      });
    });

    it('paiement client non encaissé → PAYMENT_NOT_COMPLETED', async () => {
      prisma.order.findUnique.mockResolvedValue(
        readyOrder({ Payment: [{ status: 'PENDING', amount: 6400 }] }),
      );
      const result = await service.checkEligibility('o1');
      expect(result).toMatchObject({
        eligible: false,
        code: 'PAYMENT_NOT_COMPLETED',
      });
    });

    it.each(['EN_ATTENTE', 'PAYER', 'EN_PREPARATION'])(
      'commande %s → ORDER_NOT_READY (le seuil est PRET)',
      async (status) => {
        prisma.order.findUnique.mockResolvedValue(readyOrder({ status }));
        const result = await service.checkEligibility('o1');
        expect(result).toMatchObject({
          eligible: false,
          code: 'ORDER_NOT_READY',
        });
      },
    );

    it.each(['PRET', 'EN_ROUTE', 'LIVRER'])(
      'commande %s → éligible (un reversement oublié doit rester possible)',
      async (status) => {
        prisma.order.findUnique.mockResolvedValue(readyOrder({ status }));
        const result = await service.checkEligibility('o1');
        expect(result.eligible).toBe(true);
      },
    );

    it('commande annulée → ORDER_CANCELLED', async () => {
      prisma.order.findUnique.mockResolvedValue(
        readyOrder({ status: 'ANNULER' }),
      );
      const result = await service.checkEligibility('o1');
      expect(result).toMatchObject({
        eligible: false,
        code: 'ORDER_CANCELLED',
      });
    });

    it('remboursement ouvert → ORDER_REFUNDED (on ne paie pas deux fois)', async () => {
      prisma.order.findUnique.mockResolvedValue(
        readyOrder({ refund: { status: 'PENDING' } }),
      );
      const result = await service.checkEligibility('o1');
      expect(result).toMatchObject({
        eligible: false,
        code: 'ORDER_REFUNDED',
      });
    });

    it('remboursement REJETÉ → redevient éligible', async () => {
      prisma.order.findUnique.mockResolvedValue(
        readyOrder({ refund: { status: 'REJECTED' } }),
      );
      const result = await service.checkEligibility('o1');
      expect(result.eligible).toBe(true);
    });

    it('numéro de reversement manquant → VENDOR_PAYOUT_ACCOUNT_MISSING', async () => {
      const order = readyOrder();
      order.restaurant.payoutPhoneNumber = null as never;
      prisma.order.findUnique.mockResolvedValue(order);

      const result = await service.checkEligibility('o1');
      expect(result).toMatchObject({
        eligible: false,
        code: 'VENDOR_PAYOUT_ACCOUNT_MISSING',
      });
      expect(result.reason).toContain('Mobile Money');
    });

    it('opérateur de reversement manquant → VENDOR_PAYOUT_ACCOUNT_MISSING', async () => {
      const order = readyOrder();
      order.restaurant.payoutProvider = null as never;
      prisma.order.findUnique.mockResolvedValue(order);

      const result = await service.checkEligibility('o1');
      expect(result).toMatchObject({
        eligible: false,
        code: 'VENDOR_PAYOUT_ACCOUNT_MISSING',
      });
    });

    it('déjà payé → PAYOUT_ALREADY_COMPLETED', async () => {
      prisma.order.findUnique.mockResolvedValue(
        readyOrder({ payout: { id: 'p1', status: 'SUCCESS' } }),
      );
      const result = await service.checkEligibility('o1');
      expect(result).toMatchObject({
        eligible: false,
        code: 'PAYOUT_ALREADY_COMPLETED',
      });
    });

    it('reversement en cours → PAYOUT_IN_PROGRESS', async () => {
      prisma.order.findUnique.mockResolvedValue(
        readyOrder({ payout: { id: 'p1', status: 'PENDING' } }),
      );
      const result = await service.checkEligibility('o1');
      expect(result).toMatchObject({
        eligible: false,
        code: 'PAYOUT_IN_PROGRESS',
      });
    });

    it('mode sans reversement automatique → PROVIDER_DOES_NOT_SUPPORT_PAYOUT', async () => {
      payoutSupported = false;
      prisma.order.findUnique.mockResolvedValue(readyOrder());
      const result = await service.checkEligibility('o1');
      expect(result).toMatchObject({
        eligible: false,
        code: 'PROVIDER_DOES_NOT_SUPPORT_PAYOUT',
      });
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  /**
   * ⚠️ Ce bloc a changé de sens le 17/09/2026, et c'est délibéré.
   *
   * Il affirmait auparavant que le reversement « suit un changement de taux
   * plateforme sans redéploiement ». C'était vrai, et c'était le défaut :
   * `requestPayout` lisait `Restaurant.commissionPercent` **vivant**, si bien
   * qu'un taux modifié aujourd'hui réécrivait ce que la plateforme prélèverait
   * sur des commandes passées hier et pas encore reversées.
   *
   * Le snapshot `Order.commissionPercent` existait déjà — écrit au checkout,
   * lu par personne. Il est désormais la seule autorité. Le repli
   * « vendeur sinon plateforme » n'a pas disparu : il a été ramené à l'unique
   * endroit où il a un sens, le checkout. Un seul résolveur, un seul repli.
   */
  describe('taux de commission — le SNAPSHOT de la commande fait foi', () => {
    it('applique le taux figé sur la commande, pas celui que le vendeur porte aujourd’hui', async () => {
      // Commande passée à 0 %. Le vendeur s'est vu attribuer 12 % depuis.
      const order = readyOrder({ commissionPercent: 0 });
      order.restaurant.commissionPercent = 12 as never;
      prisma.order.findUnique.mockResolvedValue(order);

      const result = await service.checkEligibility('o1');

      expect(result.breakdown).toMatchObject({
        commissionPercent: 0,
        commissionAmount: 0,
        payoutAmount: 5000,
      });
    });

    it('n’interroge JAMAIS PlatformSettings — le repli vit au checkout, pas ici', async () => {
      prisma.order.findUnique.mockResolvedValue(
        readyOrder({ commissionPercent: 8 }),
      );

      await service.checkEligibility('o1');

      expect(settings.getSettings).not.toHaveBeenCalled();
    });

    it('commission à 0 % : le vendeur reçoit l’intégralité du sous-total', async () => {
      prisma.order.findUnique.mockResolvedValue(
        readyOrder({ commissionPercent: 0 }),
      );

      const result = await service.checkEligibility('o1');

      expect(result.breakdown).toMatchObject({
        grossAmount: 5000,
        commissionAmount: 0,
        payoutAmount: 5000,
      });
    });

    it('un changement de taux VENDEUR ne réécrit pas une commande passée', async () => {
      const order = readyOrder({ commissionPercent: 10 });
      prisma.order.findUnique.mockResolvedValue(order);
      const before = await service.checkEligibility('o1');

      order.restaurant.commissionPercent = 40 as never;
      const after = await service.checkEligibility('o1');

      expect(before.breakdown?.commissionAmount).toBe(500);
      expect(after.breakdown?.commissionAmount).toBe(500);
    });

    it('un changement de taux PLATEFORME ne réécrit pas une commande passée', async () => {
      prisma.order.findUnique.mockResolvedValue(
        readyOrder({ commissionPercent: 10 }),
      );

      settings.getSettings.mockResolvedValue({
        restaurantCommissionPercent: 15,
      });
      const first = await service.checkEligibility('o1');

      settings.getSettings.mockResolvedValue({
        restaurantCommissionPercent: 40,
      });
      const second = await service.checkEligibility('o1');

      expect(first.breakdown?.commissionAmount).toBe(500);
      expect(second.breakdown?.commissionAmount).toBe(500);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  describe('requestPayout', () => {
    const createdPayout = {
      id: 'pay-1',
      orderId: 'o1',
      restaurantId: 'r1',
      grossAmount: 5000,
      commissionPercent: 10,
      commissionAmount: 500,
      amount: 4500,
      currency: 'XAF',
      status: PayoutStatus.PENDING,
      provider: 'PAWAPAY',
      failureCode: null,
      failureMessage: null,
      requestedBy: 'admin-1',
      requestedAt: new Date(),
      completedAt: null,
    };

    beforeEach(() => {
      prisma.order.findUnique.mockResolvedValue(readyOrder());
      prisma.order.findUniqueOrThrow.mockResolvedValue(readyOrder());
      // Comme la vraie base : la ligne rendue porte ce qui a été écrit — dont
      // le compte relu sous verrou, sur lequel le virement part (F-08).
      prisma.restaurantPayout.create.mockImplementation(
        async (args: { data: Record<string, unknown> }) => ({
          ...createdPayout,
          phoneNumber: args.data.phoneNumber,
          providerCode: args.data.providerCode,
        }),
      );
      payoutProvider.createPayout.mockResolvedValue({
        accepted: true,
        duplicate: false,
        raw: { status: 'ACCEPTED' },
      });
    });

    it('envoie le montant NET, jamais le brut', async () => {
      await service.requestPayout({ orderId: 'o1', adminUserId: 'admin-1' });

      expect(payoutProvider.createPayout).toHaveBeenCalledWith(
        expect.objectContaining({
          amountXaf: 4500, // et surtout PAS 5000
          currency: 'XAF',
          phoneNumber: '242061234567',
          payoutProvider: 'MTN_MOMO',
        }),
      );
    });

    it('fige le décompte financier sur la ligne', async () => {
      await service.requestPayout({ orderId: 'o1', adminUserId: 'admin-1' });

      expect(prisma.restaurantPayout.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            grossAmount: 5000,
            commissionPercent: 10,
            commissionAmount: 500,
            amount: 4500,
            requestedBy: 'admin-1',
            status: PayoutStatus.PENDING,
          }),
        }),
      );
    });

    it('fige le taux de la COMMANDE, pas celui que le vendeur porte au moment du clic', async () => {
      const order = readyOrder({ commissionPercent: 10 });
      order.restaurant.commissionPercent = 40 as never;
      prisma.order.findUnique.mockResolvedValue(order);
      prisma.order.findUniqueOrThrow.mockResolvedValue(order);

      await service.requestPayout({ orderId: 'o1', adminUserId: 'admin-1' });

      expect(prisma.restaurantPayout.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            commissionPercent: 10,
            commissionAmount: 500,
            amount: 4500, // et surtout PAS 3000, qui serait le taux d'aujourd'hui
          }),
        }),
      );
    });

    it('persiste l’identifiant prestataire AVANT l’appel réseau', async () => {
      const callOrder: string[] = [];
      prisma.restaurantPayout.create.mockImplementation(async (args: any) => {
        callOrder.push('create');
        expect(args.data.providerPayoutId).toEqual(expect.any(String));
        return createdPayout;
      });
      payoutProvider.createPayout.mockImplementation(async () => {
        callOrder.push('provider');
        return { accepted: true, duplicate: false, raw: {} };
      });

      await service.requestPayout({ orderId: 'o1', adminUserId: 'admin-1' });

      // Si l'appel partait avant l'écriture, une panne entre les deux laisserait
      // un virement sans trace — impossible à réconcilier.
      expect(callOrder).toEqual(['create', 'provider']);
    });

    it('double clic : la contrainte unique arbitre, pas un `if`', async () => {
      prisma.restaurantPayout.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('unique', {
          code: 'P2002',
          clientVersion: 'x',
        }),
      );

      await expect(
        service.requestPayout({ orderId: 'o1', adminUserId: 'admin-1' }),
      ).rejects.toBeInstanceOf(ConflictException);

      // Aucun virement n'est parti.
      expect(payoutProvider.createPayout).not.toHaveBeenCalled();
    });

    it('deux admins simultanés : un seul reversement, un seul appel', async () => {
      // Simule la base : la première insertion gagne, la seconde reçoit P2002.
      let inserted = false;
      prisma.restaurantPayout.create.mockImplementation(async () => {
        if (inserted) {
          throw new Prisma.PrismaClientKnownRequestError('unique', {
            code: 'P2002',
            clientVersion: 'x',
          });
        }
        inserted = true;
        return createdPayout;
      });

      const results = await Promise.allSettled([
        service.requestPayout({ orderId: 'o1', adminUserId: 'admin-A' }),
        service.requestPayout({ orderId: 'o1', adminUserId: 'admin-B' }),
      ]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(payoutProvider.createPayout).toHaveBeenCalledTimes(1);
    });

    it('refus du prestataire → FAILED, et le vendeur n’est PAS marqué payé', async () => {
      payoutProvider.createPayout.mockResolvedValue({
        accepted: false,
        duplicate: false,
        failureCode: 'PAWAPAY_WALLET_OUT_OF_FUNDS',
        failureMessage: 'Wallet insuffisant',
        raw: {},
      });
      prisma.restaurantPayout.updateMany.mockResolvedValue({ count: 1 });
      prisma.restaurantPayout.findUnique.mockResolvedValue({
        ...createdPayout,
        status: PayoutStatus.FAILED,
        failureCode: 'PAWAPAY_WALLET_OUT_OF_FUNDS',
      });
      (prisma.restaurantPayout as any).findUniqueOrThrow = jest
        .fn()
        .mockResolvedValue({
          ...createdPayout,
          status: PayoutStatus.FAILED,
          failureCode: 'PAWAPAY_WALLET_OUT_OF_FUNDS',
        });

      const result = await service.requestPayout({
        orderId: 'o1',
        adminUserId: 'admin-1',
      });

      expect(result.status).toBe(PayoutStatus.FAILED);
      expect(prisma.restaurantPayout.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'pay-1', status: PayoutStatus.PENDING },
          data: expect.objectContaining({ status: PayoutStatus.FAILED }),
        }),
      );
    });

    it('refuse si la commande n’est pas éligible', async () => {
      prisma.order.findUnique.mockResolvedValue(
        readyOrder({ status: 'EN_PREPARATION' }),
      );

      await expect(
        service.requestPayout({ orderId: 'o1', adminUserId: 'admin-1' }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.restaurantPayout.create).not.toHaveBeenCalled();
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  describe('retryPayout', () => {
    it('refuse de réessayer un reversement déjà réussi', async () => {
      prisma.restaurantPayout.findUnique.mockResolvedValue({
        id: 'pay-1',
        status: PayoutStatus.SUCCESS,
      });

      await expect(
        service.retryPayout({ orderId: 'o1', adminUserId: 'admin-1' }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.restaurantPayout.deleteMany).not.toHaveBeenCalled();
    });

    it('refuse de réessayer un reversement en cours', async () => {
      prisma.restaurantPayout.findUnique.mockResolvedValue({
        id: 'pay-1',
        status: PayoutStatus.PENDING,
      });

      await expect(
        service.retryPayout({ orderId: 'o1', adminUserId: 'admin-1' }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('sans reversement préalable → 404', async () => {
      prisma.restaurantPayout.findUnique.mockResolvedValue(null);
      await expect(
        service.retryPayout({ orderId: 'o1', adminUserId: 'admin-1' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('après échec : supprime, puis repart avec un NOUVEL identifiant', async () => {
      prisma.restaurantPayout.findUnique.mockResolvedValue({
        id: 'pay-1',
        status: PayoutStatus.FAILED,
        failureCode: 'PAYER_NOT_FOUND',
      });
      prisma.restaurantPayout.deleteMany.mockResolvedValue({ count: 1 });
      prisma.order.findUnique.mockResolvedValue(readyOrder());
      prisma.order.findUniqueOrThrow.mockResolvedValue(readyOrder());

      const ids: string[] = [];
      prisma.restaurantPayout.create.mockImplementation(async (args: any) => {
        ids.push(args.data.providerPayoutId);
        return { ...args.data, id: 'pay-2', requestedAt: new Date() };
      });
      payoutProvider.createPayout.mockResolvedValue({
        accepted: true,
        duplicate: false,
        raw: {},
      });

      await service.retryPayout({ orderId: 'o1', adminUserId: 'admin-1' });

      // Réutiliser l'ancien identifiant ferait répondre DUPLICATE_IGNORED : la
      // tentative semblerait acceptée sans que rien ne parte.
      expect(prisma.restaurantPayout.deleteMany).toHaveBeenCalledWith({
        where: { id: 'pay-1', status: PayoutStatus.FAILED },
      });
      expect(ids[0]).toEqual(expect.any(String));
    });

    /**
     * La reprise supprime la ligne échouée et rebâtit le décompte. Tant que
     * celui-ci se calculait sur le taux vivant, une reprise après changement de
     * taux versait un montant différent de la tentative d'origine — sans que
     * rien ne le signale. Le snapshot rend la reprise reproductible par
     * construction.
     */
    it('une reprise après changement de taux reproduit EXACTEMENT le même montant', async () => {
      prisma.restaurantPayout.findUnique.mockResolvedValue({
        id: 'pay-1',
        status: PayoutStatus.FAILED,
        failureCode: 'PAYER_NOT_FOUND',
      });
      prisma.restaurantPayout.deleteMany.mockResolvedValue({ count: 1 });

      const order = readyOrder({ commissionPercent: 10 });
      // Entre l'échec et la reprise, le vendeur passe à 40 % et la plateforme
      // à 25 %. Ni l'un ni l'autre ne concerne cette commande-ci.
      order.restaurant.commissionPercent = 40 as never;
      settings.getSettings.mockResolvedValue({
        restaurantCommissionPercent: 25,
      });
      prisma.order.findUnique.mockResolvedValue(order);
      prisma.order.findUniqueOrThrow.mockResolvedValue(order);

      prisma.restaurantPayout.create.mockImplementation(async (args: any) => ({
        ...args.data,
        id: 'pay-2',
        requestedAt: new Date(),
      }));
      payoutProvider.createPayout.mockResolvedValue({
        accepted: true,
        duplicate: false,
        raw: {},
      });

      await service.retryPayout({ orderId: 'o1', adminUserId: 'admin-1' });

      expect(prisma.restaurantPayout.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            commissionPercent: 10,
            commissionAmount: 500,
            amount: 4500,
          }),
        }),
      );
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  describe('applyPayoutProviderStatus', () => {
    const pendingPayout = {
      id: 'pay-1',
      orderId: 'o1',
      restaurantId: 'r1',
      amount: 4500,
      currency: 'XAF',
      provider: 'PAWAPAY',
      providerPayoutId: 'uuid-1',
      status: PayoutStatus.PENDING,
      restaurant: { id: 'r1', nom: 'Chez Mere Lili', ownerId: 'owner-1' },
    };

    it('COMPLETED → SUCCESS + notification vendeur', async () => {
      prisma.restaurantPayout.findUnique.mockResolvedValue(pendingPayout);
      prisma.restaurantPayout.updateMany.mockResolvedValue({ count: 1 });

      const outcome = await service.applyPayoutProviderStatus({
        payoutId: 'pay-1',
        status: {
          state: 'SUCCESS',
          rawStatus: 'COMPLETED',
          amountXaf: 4500,
          currency: 'XAF',
          raw: {},
        },
        source: PaymentEventSource.WEBHOOK,
      });

      expect(outcome).toBe('APPLIED');
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'payout.succeeded',
        expect.objectContaining({ ownerId: 'owner-1', amount: 4500 }),
      );
    });

    it('webhook rejoué → DUPLICATE, aucune seconde notification', async () => {
      prisma.restaurantPayout.findUnique.mockResolvedValue(pendingPayout);
      prisma.restaurantPayout.updateMany.mockResolvedValue({ count: 0 });

      const outcome = await service.applyPayoutProviderStatus({
        payoutId: 'pay-1',
        status: {
          state: 'SUCCESS',
          rawStatus: 'COMPLETED',
          amountXaf: 4500,
          currency: 'XAF',
          raw: {},
        },
        source: PaymentEventSource.WEBHOOK,
      });

      expect(outcome).toBe('DUPLICATE');
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it('FAILED arrivé APRÈS un COMPLETED → DUPLICATE, le succès tient', async () => {
      // La ligne est déjà SUCCESS : `updateMany WHERE status=PENDING` n'affecte
      // rien. Un callback tardif ne peut pas défaire un virement effectué.
      prisma.restaurantPayout.findUnique.mockResolvedValue({
        ...pendingPayout,
        status: PayoutStatus.SUCCESS,
      });
      prisma.restaurantPayout.updateMany.mockResolvedValue({ count: 0 });

      const outcome = await service.applyPayoutProviderStatus({
        payoutId: 'pay-1',
        status: {
          state: 'FAILED',
          rawStatus: 'FAILED',
          amountXaf: 4500,
          currency: 'XAF',
          raw: {},
        },
        source: PaymentEventSource.WEBHOOK,
      });

      expect(outcome).toBe('DUPLICATE');
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it('statut non terminal → IGNORED, rien ne bouge', async () => {
      prisma.restaurantPayout.findUnique.mockResolvedValue(pendingPayout);

      const outcome = await service.applyPayoutProviderStatus({
        payoutId: 'pay-1',
        status: {
          state: 'PENDING',
          rawStatus: 'IN_RECONCILIATION',
          raw: {},
        },
        source: PaymentEventSource.WEBHOOK,
      });

      expect(outcome).toBe('IGNORED');
      expect(prisma.restaurantPayout.updateMany).not.toHaveBeenCalled();
    });

    it('montant incohérent → MISMATCH, incident, AUCUNE transition', async () => {
      prisma.restaurantPayout.findUnique.mockResolvedValue(pendingPayout);

      const outcome = await service.applyPayoutProviderStatus({
        payoutId: 'pay-1',
        status: {
          state: 'SUCCESS',
          rawStatus: 'COMPLETED',
          amountXaf: 9000, // on avait envoyé 4500
          currency: 'XAF',
          raw: {},
        },
        source: PaymentEventSource.WEBHOOK,
      });

      expect(outcome).toBe('MISMATCH');
      expect(prisma.restaurantPayout.updateMany).not.toHaveBeenCalled();
      expect(prisma.incident.create).toHaveBeenCalled();
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it('devise incohérente → MISMATCH', async () => {
      prisma.restaurantPayout.findUnique.mockResolvedValue(pendingPayout);

      const outcome = await service.applyPayoutProviderStatus({
        payoutId: 'pay-1',
        status: {
          state: 'SUCCESS',
          rawStatus: 'COMPLETED',
          amountXaf: 4500,
          currency: 'USD',
          raw: {},
        },
        source: PaymentEventSource.WEBHOOK,
      });

      expect(outcome).toBe('MISMATCH');
      expect(prisma.restaurantPayout.updateMany).not.toHaveBeenCalled();
    });

    it('reversement inconnu → IGNORED', async () => {
      prisma.restaurantPayout.findUnique.mockResolvedValue(null);

      const outcome = await service.applyPayoutProviderStatus({
        payoutId: 'inconnu',
        status: { state: 'SUCCESS', rawStatus: 'COMPLETED', raw: {} },
        source: PaymentEventSource.WEBHOOK,
      });

      expect(outcome).toBe('IGNORED');
    });
  });
});
