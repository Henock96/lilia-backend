import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ConflictException } from '@nestjs/common';

import { PaymentService } from './services/payment.service';
import { PaymentEventService } from './services/payment-event.service';
import { PaymentProviderRegistry } from './payment-provider.registry';
import { OutboxService } from '../outbox/outbox.service';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Résurrection de commande et commande à total nul (fixes H2 et M3 — audit du
 * 28/08/2026).
 *
 * H2, scénario **sans attaquant** : le client vire l'argent, l'admin est en
 * week-end, la commande expire au bout de 6 h (stock restauré, points
 * recrédités, PromoUsage supprimée). Lundi, l'admin retrouve le virement et
 * clique « Confirmer » : la commande repassait `ANNULER → PAYER`. Elle était
 * alors payée alors que le stock avait été rendu et le code promo libéré.
 */
describe('PaymentService — résurrection (H2) et total nul (M3)', () => {
  let service: PaymentService;

  const prisma = {
    user: { findUnique: jest.fn() },
    payment: {
      findUniqueOrThrow: jest.fn(),
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      count: jest.fn().mockResolvedValue(0),
      updateMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    order: {
      updateMany: jest.fn(),
      findUnique: jest.fn(),
      findFirst: jest.fn(),
    },
    paymentEvent: {
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    incident: { create: jest.fn() },
    $transaction: jest.fn(),
  };
  const eventEmitter = { emit: jest.fn() };
  const events = {
    record: jest.fn().mockResolvedValue('evt-1'),
    setOutcome: jest.fn(),
  };
  const outbox = { enqueueInTransaction: jest.fn().mockResolvedValue('ob-1') };
  /**
   * Le mode MANUAL n'appelle aucun prestataire : un provider inerte suffit. Les
   * chemins réseau sont couverts par `pawapay.provider.spec.ts`.
   */
  const manualProvider = {
    name: 'MANUAL',
    supportsCollection: true,
    supportsPayout: false,
    createCollection: jest.fn(),
    getCollectionStatus: jest.fn().mockResolvedValue(null),
    createPayout: jest.fn(),
    getPayoutStatus: jest.fn().mockResolvedValue(null),
  };
  const registry = {
    currentMode: 'MANUAL',
    forNewTransaction: () => manualProvider,
    forStoredProvider: () => manualProvider,
    forPayout: () => null,
  };

  beforeEach(async () => {
    jest.resetAllMocks();
    prisma.$transaction.mockImplementation(async (arg: any) =>
      typeof arg === 'function' ? arg(prisma) : Promise.all(arg),
    );
    events.record.mockResolvedValue('evt-1');
    outbox.enqueueInTransaction.mockResolvedValue('ob-1');
    prisma.paymentEvent.findFirst.mockResolvedValue(null);

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
          useValue: {
            get: (k: string, d?: unknown) =>
              k === 'PAYMENT_MODE' ? 'MANUAL' : d,
          },
        },
      ],
    }).compile();

    service = module.get(PaymentService);
  });

  describe('confirmManualPayment', () => {
    it('confirme un paiement sur une commande EN_ATTENTE', async () => {
      // `confirmManualPayment` délègue à `applyCollectionProviderStatus`, qui
      // relit le paiement avec sa commande : les deux lectures sont simulées.
      prisma.payment.findUnique.mockResolvedValue({
        id: 'p1',
        status: 'PENDING',
        amount: 5000,
        currency: 'XAF',
        provider: 'MANUAL',
        providerTransactionId: null,
        orderId: 'o1',
        order: {
          id: 'o1',
          status: 'EN_ATTENTE',
          userId: 'u1',
          restaurantId: 'r1',
        },
      });
      prisma.payment.findUniqueOrThrow.mockResolvedValue({
        id: 'p1',
        status: 'PENDING',
        amount: 5000,
        orderId: 'o1',
        order: {
          id: 'o1',
          status: 'EN_ATTENTE',
          userId: 'u1',
          restaurantId: 'r1',
        },
      });
      prisma.payment.updateMany.mockResolvedValue({ count: 1 });
      prisma.order.updateMany.mockResolvedValue({ count: 1 });

      await expect(service.confirmManualPayment('p1')).resolves.toEqual({
        message: 'Paiement confirmé manuellement',
      });

      expect(prisma.order.updateMany).toHaveBeenCalledWith({
        where: { id: 'o1', status: 'EN_ATTENTE' },
        data: expect.objectContaining({ status: 'PAYER' }),
      });
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'order.payment.confirmed',
        expect.anything(),
      );
    });

    it.each(['ANNULER', 'LIVRER', 'EN_PREPARATION'])(
      'refuse en 409 sur une commande %s — plus de résurrection',
      async (status) => {
        prisma.payment.findUniqueOrThrow.mockResolvedValue({
          id: 'p1',
          status: 'PENDING',
          orderId: 'o1',
          order: { id: 'o1', status, userId: 'u1', restaurantId: 'r1' },
        });

        await expect(service.confirmManualPayment('p1')).rejects.toBeInstanceOf(
          ConflictException,
        );

        // Rien n'est écrit, et surtout aucun événement n'est émis : le vendeur
        // ne reçoit pas une commande à préparer que le système croit annulée.
        expect(prisma.order.updateMany).not.toHaveBeenCalled();
        expect(eventEmitter.emit).not.toHaveBeenCalled();
      },
    );

    it("n'annonce jamais un paiement confirmé si la commande a bougé", async () => {
      // Course entre la vérification et la transaction : la commande était
      // EN_ATTENTE au contrôle, elle ne l'est plus au moment d'écrire.
      //
      // ⚠️ Le comportement a changé avec le chantier pawaPay, délibérément.
      // Auparavant on levait, ce qui annulait aussi l'écriture du paiement —
      // donc on perdait la trace d'un encaissement réel. Désormais le paiement
      // est enregistré SUCCESS (l'argent existe), la commande n'est PAS forcée,
      // et `payment.orphaned` ouvre un incident pour qu'un remboursement soit
      // traité.
      //
      // La propriété que ce test protège est inchangée : aucune notification de
      // confirmation ne part pour une commande qui n'a pas été payée.
      prisma.payment.findUnique.mockResolvedValue({
        id: 'p1',
        status: 'PENDING',
        amount: 5000,
        currency: 'XAF',
        provider: 'MANUAL',
        providerTransactionId: null,
        orderId: 'o1',
        order: {
          id: 'o1',
          status: 'EN_ATTENTE',
          userId: 'u1',
          restaurantId: 'r1',
        },
      });
      prisma.payment.findUniqueOrThrow.mockResolvedValue({
        id: 'p1',
        status: 'PENDING',
        amount: 5000,
        orderId: 'o1',
        order: {
          id: 'o1',
          status: 'EN_ATTENTE',
          userId: 'u1',
          restaurantId: 'r1',
        },
      });
      prisma.payment.updateMany.mockResolvedValue({ count: 1 });
      prisma.order.updateMany.mockResolvedValue({ count: 0 }); // statut changé

      await service.confirmManualPayment('p1');

      const emitted = eventEmitter.emit.mock.calls.map((c: any[]) => c[0]);
      expect(emitted).not.toContain('order.payment.confirmed');
      expect(emitted).not.toContain('order.paid');
      expect(emitted).toContain('payment.orphaned');
    });
  });

  describe('commande à total 0 (M3)', () => {
    const zeroOrder = {
      id: 'o1',
      total: 0,
      userId: 'u1',
      restaurantId: 'r1',
      status: 'EN_ATTENTE',
      paymentMethod: 'MTN_MOMO',
      restaurant: { nom: 'Resto' },
    };

    beforeEach(() => {
      // `getPayableOrder` vérifie la propriété puis charge la commande.
      prisma.user.findUnique.mockResolvedValue({ id: 'u1', role: 'CLIENT' });
      prisma.order.findUnique.mockResolvedValue(zeroOrder);
    });

    it('marque la commande payée sans passer par l’opérateur', async () => {
      prisma.payment.findFirst.mockResolvedValue(null);
      prisma.payment.create.mockResolvedValue({ id: 'p-zero' });
      prisma.order.updateMany.mockResolvedValue({ count: 1 });

      const res: any = await service.createPayment(
        { orderId: 'o1', phoneNumber: '060000000' } as any,
        'uid-1',
      );

      expect(res.mode).toBe('ZERO_AMOUNT');
      expect(res.instructions.amount).toBe(0);
      // Plus d'instruction « Envoyez 0 FCFA au … », plus d'expiration au bout
      // de 45 min sur une commande que personne ne pouvait payer.
      expect(prisma.order.updateMany).toHaveBeenCalledWith({
        where: { id: 'o1', status: 'EN_ATTENTE' },
        data: expect.objectContaining({ status: 'PAYER' }),
      });
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'order.payment.confirmed',
        expect.anything(),
      );
    });

    it('idempotent : un second appel ne réémet rien', async () => {
      prisma.payment.findFirst.mockResolvedValue({ id: 'p-zero', amount: 0 });

      const res: any = await service.createPayment(
        { orderId: 'o1', phoneNumber: '060000000' } as any,
        'uid-1',
      );

      expect(res.paymentId).toBe('p-zero');
      expect(prisma.payment.create).not.toHaveBeenCalled();
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });
  });
});
