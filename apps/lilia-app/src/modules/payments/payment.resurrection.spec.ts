import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ConflictException } from '@nestjs/common';

import { PaymentService } from './services/payment.service';
import { MtnMomoService } from './services/mtn-momo.service';
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
      findFirst: jest.fn(),
      updateMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    order: {
      updateMany: jest.fn(),
      findUnique: jest.fn(),
      findFirst: jest.fn(),
    },
    $transaction: jest.fn(),
  };
  const eventEmitter = { emit: jest.fn() };

  beforeEach(async () => {
    jest.resetAllMocks();
    prisma.$transaction.mockImplementation(async (arg: any) =>
      typeof arg === 'function' ? arg(prisma) : Promise.all(arg),
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentService,
        { provide: PrismaService, useValue: prisma },
        { provide: MtnMomoService, useValue: {} },
        { provide: EventEmitter2, useValue: eventEmitter },
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

    it('émet l’événement APRÈS le commit, jamais avant', async () => {
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
      prisma.order.updateMany.mockResolvedValue({ count: 0 }); // statut changé entre-temps

      await expect(service.confirmManualPayment('p1')).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(eventEmitter.emit).not.toHaveBeenCalled();
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
