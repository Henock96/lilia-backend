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
  describe('commission configurable', () => {
    it('utilise le taux du vendeur quand il en a un', async () => {
      const order = readyOrder();
      order.restaurant.commissionPercent = 12 as never;
      prisma.order.findUnique.mockResolvedValue(order);

      const result = await service.checkEligibility('o1');

      expect(result.breakdown).toMatchObject({
        commissionPercent: 12,
        commissionAmount: 600,
        payoutAmount: 4400,
      });
      // Le taux plateforme n'a pas été consulté : celui du vendeur prime.
      expect(settings.getSettings).not.toHaveBeenCalled();
    });

    it('retombe sur le taux plateforme quand le vendeur n’en a pas', async () => {
      settings.getSettings.mockResolvedValue({
        restaurantCommissionPercent: 8,
      });
      prisma.order.findUnique.mockResolvedValue(readyOrder());

      const result = await service.checkEligibility('o1');

      expect(result.breakdown).toMatchObject({
        commissionPercent: 8,
        commissionAmount: 400,
        payoutAmount: 4600,
      });
    });

    it('suit un changement de taux plateforme sans redéploiement', async () => {
      prisma.order.findUnique.mockResolvedValue(readyOrder());

      settings.getSettings.mockResolvedValue({
        restaurantCommissionPercent: 15,
      });
      const first = await service.checkEligibility('o1');
      expect(first.breakdown?.commissionAmount).toBe(750);

      settings.getSettings.mockResolvedValue({
        restaurantCommissionPercent: 12,
      });
      const second = await service.checkEligibility('o1');
      expect(second.breakdown?.commissionAmount).toBe(600);
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
      prisma.restaurantPayout.create.mockResolvedValue(createdPayout);
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
