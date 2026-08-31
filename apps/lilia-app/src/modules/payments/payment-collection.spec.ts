import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  NotFoundException,
} from '@nestjs/common';
import { PaymentEventSource, Prisma } from '@prisma/client';

import { PaymentService } from './services/payment.service';
import { PaymentEventService } from './services/payment-event.service';
import { PaymentProviderRegistry } from './payment-provider.registry';
import { ProviderUnavailableError } from './providers/payment-provider.interface';
import { OutboxService } from '../outbox/outbox.service';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Encaissement client — idempotence, sécurité, transitions.
 *
 * Les trois propriétés que ces tests protègent :
 *  1. **un seul débit** quoi qu'il arrive (double clic, retry réseau, webhook
 *     rejoué) ;
 *  2. **le montant vient du serveur**, jamais du client ;
 *  3. **un échec de paiement n'annule jamais une commande** — c'est ce qui rend
 *     la reprise possible.
 */
describe('PaymentService — encaissement', () => {
  let service: PaymentService;

  const prisma = {
    user: { findUnique: jest.fn() },
    order: { findUnique: jest.fn(), updateMany: jest.fn() },
    payment: {
      create: jest.fn(),
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      updateMany: jest.fn(),
      count: jest.fn(),
    },
    paymentEvent: { findFirst: jest.fn() },
    incident: { create: jest.fn() },
    $transaction: jest.fn(),
  };

  const events = {
    record: jest.fn().mockResolvedValue('evt-1'),
    setOutcome: jest.fn(),
  };
  const eventEmitter = { emit: jest.fn() };
  const outbox = { enqueueInTransaction: jest.fn().mockResolvedValue('ob-1') };

  const provider = {
    name: 'PAWAPAY',
    supportsCollection: true,
    supportsPayout: true,
    createCollection: jest.fn(),
    getCollectionStatus: jest.fn(),
    createPayout: jest.fn(),
    getPayoutStatus: jest.fn(),
  };
  const registry = {
    currentMode: 'PAWAPAY',
    forNewTransaction: () => provider,
    forStoredProvider: () => provider,
    forPayout: () => provider,
  };

  const payableOrder = (overrides: Record<string, unknown> = {}) => ({
    id: 'o1',
    userId: 'u1',
    restaurantId: 'r1',
    status: 'EN_ATTENTE',
    total: 6400,
    paymentMethod: 'MTN_MOMO',
    restaurant: { nom: 'Chez Mere Lili' },
    ...overrides,
  });

  const pendingPayment = {
    id: 'pay-1',
    orderId: 'o1',
    amount: 6400,
    currency: 'XAF',
    method: 'MTN_MOMO',
    provider: 'PAWAPAY',
    providerTransactionId: 'uuid-1',
    status: 'PENDING',
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    prisma.$transaction.mockImplementation(async (arg: any) =>
      typeof arg === 'function' ? arg(prisma) : Promise.all(arg),
    );
    events.record.mockResolvedValue('evt-1');
    outbox.enqueueInTransaction.mockResolvedValue('ob-1');
    prisma.payment.count.mockResolvedValue(0);
    prisma.paymentEvent.findFirst.mockResolvedValue(null);
    prisma.incident.create.mockResolvedValue({ id: 'inc-1' });
    prisma.user.findUnique.mockResolvedValue({ id: 'u1', role: 'CLIENT' });
    prisma.order.findUnique.mockResolvedValue(payableOrder());
    prisma.payment.create.mockResolvedValue(pendingPayment);
    provider.createCollection.mockResolvedValue({
      accepted: true,
      duplicate: false,
      raw: {},
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentService,
        { provide: PrismaService, useValue: prisma },
        { provide: EventEmitter2, useValue: eventEmitter },
        { provide: PaymentEventService, useValue: events },
        { provide: PaymentProviderRegistry, useValue: registry },
        { provide: OutboxService, useValue: outbox },
        {
          provide: ConfigService,
          useValue: { get: (_k: string, d?: unknown) => d },
        },
      ],
    }).compile();

    service = module.get(PaymentService);
  });

  // ══════════════════════════════════════════════════════════════════════════
  describe('montant — le serveur fait foi', () => {
    it('ignore un montant envoyé par le client', async () => {
      await service.createPayment(
        {
          orderId: 'o1',
          phoneNumber: '061234567',
          amount: 1, // tentative de payer 1 F au lieu de 6 400
        } as never,
        'uid-1',
      );

      expect(prisma.payment.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ amount: 6400 }),
        }),
      );
      expect(provider.createCollection).toHaveBeenCalledWith(
        expect.objectContaining({ amountXaf: 6400 }),
      );
    });

    it('génère et PERSISTE la référence prestataire avant l’appel réseau', async () => {
      const order: string[] = [];
      prisma.payment.create.mockImplementation(async (args: any) => {
        order.push('persist');
        expect(args.data.providerTransactionId).toEqual(expect.any(String));
        return { ...pendingPayment, ...args.data };
      });
      provider.createCollection.mockImplementation(async () => {
        order.push('provider');
        return { accepted: true, duplicate: false, raw: {} };
      });

      await service.createPayment(
        { orderId: 'o1', phoneNumber: '061234567' } as never,
        'uid-1',
      );

      // Sans cet ordre, un timeout réseau ferait repartir une NOUVELLE référence
      // au retry — donc un second débit.
      expect(order).toEqual(['persist', 'provider']);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  describe('idempotence', () => {
    it('double clic : la contrainte unique arbitre, un seul appel prestataire', async () => {
      prisma.payment.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('unique', {
          code: 'P2002',
          clientVersion: 'x',
        }),
      );
      prisma.payment.findFirst.mockResolvedValue(pendingPayment);
      // Une demande a déjà été soumise pour ce paiement.
      prisma.paymentEvent.findFirst.mockResolvedValue({ id: 'evt-0' });

      const res: any = await service.createPayment(
        { orderId: 'o1', phoneNumber: '061234567' } as never,
        'uid-1',
      );

      expect(res.paymentId).toBe('pay-1');
      expect(provider.createCollection).not.toHaveBeenCalled();
    });

    it('retry après panne réseau : réutilise la MÊME référence', async () => {
      prisma.payment.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('unique', {
          code: 'P2002',
          clientVersion: 'x',
        }),
      );
      prisma.payment.findFirst.mockResolvedValue(pendingPayment);
      // Aucune demande n'a abouti : on rejoue.
      prisma.paymentEvent.findFirst.mockResolvedValue(null);

      await service.createPayment(
        { orderId: 'o1', phoneNumber: '061234567' } as never,
        'uid-1',
      );

      expect(provider.createCollection).toHaveBeenCalledWith(
        expect.objectContaining({ providerTransactionId: 'uuid-1' }),
      );
    });

    it('webhook rejoué → DUPLICATE, aucun second événement', async () => {
      prisma.payment.findUnique.mockResolvedValue({
        ...pendingPayment,
        order: {
          id: 'o1',
          userId: 'u1',
          restaurantId: 'r1',
          status: 'PAYER',
        },
      });
      prisma.payment.updateMany.mockResolvedValue({ count: 0 });

      const outcome = await service.applyCollectionProviderStatus({
        paymentId: 'pay-1',
        status: {
          state: 'SUCCESS',
          rawStatus: 'COMPLETED',
          amountXaf: 6400,
          currency: 'XAF',
          raw: {},
        },
        source: PaymentEventSource.WEBHOOK,
      });

      expect(outcome).toBe('DUPLICATE');
      expect(eventEmitter.emit).not.toHaveBeenCalled();
      expect(outbox.enqueueInTransaction).not.toHaveBeenCalled();
    });

    it('FAILED reçu APRÈS un COMPLETED → DUPLICATE, l’encaissement tient', async () => {
      prisma.payment.findUnique.mockResolvedValue({
        ...pendingPayment,
        status: 'SUCCESS',
        order: { id: 'o1', userId: 'u1', restaurantId: 'r1', status: 'PAYER' },
      });
      prisma.payment.updateMany.mockResolvedValue({ count: 0 });

      const outcome = await service.applyCollectionProviderStatus({
        paymentId: 'pay-1',
        status: {
          state: 'FAILED',
          rawStatus: 'FAILED',
          amountXaf: 6400,
          currency: 'XAF',
          raw: {},
        },
        source: PaymentEventSource.WEBHOOK,
      });

      expect(outcome).toBe('DUPLICATE');
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  describe('transitions', () => {
    const pendingWithOrder = {
      ...pendingPayment,
      order: {
        id: 'o1',
        userId: 'u1',
        restaurantId: 'r1',
        status: 'EN_ATTENTE',
      },
    };

    it('COMPLETED → commande PAYER + obligation de notifier le vendeur', async () => {
      prisma.payment.findUnique.mockResolvedValue(pendingWithOrder);
      prisma.payment.updateMany.mockResolvedValue({ count: 1 });
      prisma.order.updateMany.mockResolvedValue({ count: 1 });

      const outcome = await service.applyCollectionProviderStatus({
        paymentId: 'pay-1',
        status: {
          state: 'SUCCESS',
          rawStatus: 'COMPLETED',
          amountXaf: 6400,
          currency: 'XAF',
          raw: {},
        },
        source: PaymentEventSource.WEBHOOK,
      });

      expect(outcome).toBe('APPLIED');
      expect(prisma.order.updateMany).toHaveBeenCalledWith({
        where: { id: 'o1', status: 'EN_ATTENTE' },
        data: expect.objectContaining({ status: 'PAYER' }),
      });
      // L'obligation de prévenir le vendeur est écrite DANS la transaction :
      // si la commande est payée, la notification est due.
      expect(outbox.enqueueInTransaction).toHaveBeenCalledWith(
        prisma,
        expect.objectContaining({ type: 'order.paid', aggregateId: 'o1' }),
      );
    });

    it('FAILED → paiement en échec, mais la COMMANDE reste payable', async () => {
      prisma.payment.findUnique.mockResolvedValue(pendingWithOrder);
      prisma.payment.updateMany.mockResolvedValue({ count: 1 });

      const outcome = await service.applyCollectionProviderStatus({
        paymentId: 'pay-1',
        status: {
          state: 'FAILED',
          rawStatus: 'FAILED',
          amountXaf: 6400,
          currency: 'XAF',
          failureCode: 'PAYMENT_NOT_APPROVED',
          raw: {},
        },
        source: PaymentEventSource.WEBHOOK,
      });

      expect(outcome).toBe('APPLIED');
      // ⚠️ La propriété centrale de la reprise : aucune écriture sur la commande.
      expect(prisma.order.updateMany).not.toHaveBeenCalled();
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'order.payment.failed',
        expect.objectContaining({ orderId: 'o1' }),
      );
    });

    it('statut non terminal → IGNORED', async () => {
      prisma.payment.findUnique.mockResolvedValue(pendingWithOrder);

      const outcome = await service.applyCollectionProviderStatus({
        paymentId: 'pay-1',
        status: { state: 'PENDING', rawStatus: 'PROCESSING', raw: {} },
        source: PaymentEventSource.WEBHOOK,
      });

      expect(outcome).toBe('IGNORED');
      expect(prisma.payment.updateMany).not.toHaveBeenCalled();
    });

    it('montant incohérent → MISMATCH, incident, aucune transition', async () => {
      prisma.payment.findUnique.mockResolvedValue(pendingWithOrder);

      const outcome = await service.applyCollectionProviderStatus({
        paymentId: 'pay-1',
        status: {
          state: 'SUCCESS',
          rawStatus: 'COMPLETED',
          amountXaf: 100, // on attendait 6400
          currency: 'XAF',
          raw: {},
        },
        source: PaymentEventSource.WEBHOOK,
      });

      expect(outcome).toBe('MISMATCH');
      expect(prisma.payment.updateMany).not.toHaveBeenCalled();
      expect(prisma.order.updateMany).not.toHaveBeenCalled();
      expect(prisma.incident.create).toHaveBeenCalled();
    });

    it('encaissement sur commande expirée → orphelin signalé, rien de forcé', async () => {
      prisma.payment.findUnique.mockResolvedValue(pendingWithOrder);
      prisma.payment.updateMany.mockResolvedValue({ count: 1 });
      prisma.order.updateMany.mockResolvedValue({ count: 0 }); // annulée entre-temps

      const outcome = await service.applyCollectionProviderStatus({
        paymentId: 'pay-1',
        status: {
          state: 'SUCCESS',
          rawStatus: 'COMPLETED',
          amountXaf: 6400,
          currency: 'XAF',
          raw: {},
        },
        source: PaymentEventSource.WEBHOOK,
      });

      expect(outcome).toBe('APPLIED');
      const emitted = eventEmitter.emit.mock.calls.map((c: any[]) => c[0]);
      expect(emitted).toContain('payment.orphaned');
      expect(emitted).not.toContain('order.payment.confirmed');
      expect(outbox.enqueueInTransaction).not.toHaveBeenCalled();
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  describe('sécurité et garde-fous', () => {
    it('commande d’un autre client → 403', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'autre', role: 'CLIENT' });

      await expect(
        service.createPayment(
          { orderId: 'o1', phoneNumber: '061234567' } as never,
          'uid-autre',
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(provider.createCollection).not.toHaveBeenCalled();
    });

    it('commande inexistante → 404', async () => {
      prisma.order.findUnique.mockResolvedValue(null);

      await expect(
        service.createPayment(
          { orderId: 'inconnue', phoneNumber: '061234567' } as never,
          'uid-1',
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it.each(['PAYER', 'EN_PREPARATION', 'LIVRER', 'ANNULER'])(
      'commande %s → 400, non payable',
      async (status) => {
        prisma.order.findUnique.mockResolvedValue(payableOrder({ status }));

        await expect(
          service.createPayment(
            { orderId: 'o1', phoneNumber: '061234567' } as never,
            'uid-1',
          ),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(provider.createCollection).not.toHaveBeenCalled();
      },
    );

    it('plafond de tentatives atteint → 400', async () => {
      // Sans plafond, chaque appel déclenche une opération facturée ET un message
      // sur le téléphone saisi : l'endpoint deviendrait un outil de harcèlement.
      prisma.payment.count.mockResolvedValue(3);

      await expect(
        service.createPayment(
          { orderId: 'o1', phoneNumber: '061234567' } as never,
          'uid-1',
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.payment.create).not.toHaveBeenCalled();
    });

    it('ADMIN peut payer pour un client (support)', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'admin', role: 'ADMIN' });

      await expect(
        service.createPayment(
          { orderId: 'o1', phoneNumber: '061234567' } as never,
          'uid-admin',
        ),
      ).resolves.toMatchObject({ paymentId: 'pay-1' });
    });

    it('prestataire injoignable → 502, ligne conservée PENDING', async () => {
      provider.createCollection.mockRejectedValue(
        new ProviderUnavailableError('injoignable', 503),
      );

      await expect(
        service.createPayment(
          { orderId: 'o1', phoneNumber: '061234567' } as never,
          'uid-1',
        ),
      ).rejects.toBeInstanceOf(HttpException);

      // On ne marque SURTOUT pas l'échec : on ignore si la demande est partie.
      expect(prisma.payment.updateMany).not.toHaveBeenCalled();
    });

    it('refus du prestataire → paiement FAILED, commande intacte', async () => {
      provider.createCollection.mockResolvedValue({
        accepted: false,
        duplicate: false,
        failureCode: 'INVALID_PHONE_NUMBER',
        failureMessage: 'Numéro invalide',
        raw: {},
      });
      prisma.payment.updateMany.mockResolvedValue({ count: 1 });

      await expect(
        service.createPayment(
          { orderId: 'o1', phoneNumber: '061234567' } as never,
          'uid-1',
        ),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(prisma.payment.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'pay-1', status: 'PENDING' },
          data: expect.objectContaining({ status: 'FAILED' }),
        }),
      );
      expect(prisma.order.updateMany).not.toHaveBeenCalled();
    });
  });
});
