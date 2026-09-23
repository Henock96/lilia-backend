import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { OrderStatus } from '@prisma/client';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { AcceptOrderDto, RejectOrderDto } from './dto/order-acceptance.dto';
import { OrderLifecycleService } from './order-lifecycle.service';
import { OrderStateMachine } from './order-state.machine';
import { OrderTransitionService } from './order-transition.service';

/**
 * Acceptation vendeur (Phase 3, F3-01).
 *
 * Vraie machine à états et vrai point d'écriture du statut : c'est leur couple
 * qui porte la règle, les simuler laisserait passer une incohérence.
 */
describe('OrderLifecycleService — acceptation et refus vendeur (F3-01)', () => {
  const VENDOR = { id: 'u-vendor', role: 'RESTAURATEUR', firebaseUid: 'fb-v' };
  const OTHER_VENDOR = {
    id: 'u-other',
    role: 'RESTAURATEUR',
    firebaseUid: 'fb-o',
  };
  const ADMIN = { id: 'u-admin', role: 'ADMIN', firebaseUid: 'fb-a' };
  const NOW = new Date('2026-09-24T12:00:00.000Z');

  beforeAll(() =>
    jest.useFakeTimers({
      now: NOW.getTime(),
      doNotFake: ['nextTick', 'setImmediate'],
    }),
  );
  afterAll(() => jest.useRealTimers());

  function build(opts: {
    status?: OrderStatus;
    user?: typeof VENDOR;
    isPreorder?: boolean;
    acceptanceRequired?: boolean;
  }) {
    const order = {
      id: 'o-1',
      userId: 'u-client',
      restaurantId: 'r-1',
      status: opts.status ?? ('PAYER' as OrderStatus),
      isDelivery: true,
      isPreorder: opts.isPreorder ?? false,
      subTotal: 5000,
      total: 6750,
      restaurant: { nom: 'Chez Awa', ownerId: VENDOR.id },
      items: [],
    };
    const tx = {
      order: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: jest.fn().mockResolvedValue(order),
      },
      orderHistory: { create: jest.fn().mockResolvedValue({}) },
      platformSettings: { findUnique: jest.fn().mockResolvedValue(null) },
      restaurantPayout: { findUnique: jest.fn().mockResolvedValue(null) },
      loyaltyTransaction: {
        aggregate: jest.fn().mockResolvedValue({ _sum: { points: 0 } }),
      },
      promoUsage: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
      $executeRaw: jest.fn(),
      $queryRaw: jest.fn().mockResolvedValue([]),
    };
    const settings = {
      orderAcceptanceRequired: opts.acceptanceRequired ?? false,
    };
    const prisma = {
      user: { findUnique: jest.fn().mockResolvedValue(opts.user ?? VENDOR) },
      order: { findUnique: jest.fn().mockResolvedValue(order) },
      platformSettings: { findUnique: jest.fn().mockResolvedValue(settings) },
      $transaction: jest.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
    };
    const eventEmitter = { emit: jest.fn() };
    const audit = { record: jest.fn() };
    const outbox = { enqueueInTransaction: jest.fn() };

    const service = new OrderLifecycleService(
      prisma as never,
      eventEmitter as never,
      new OrderStateMachine(),
      new OrderTransitionService(),
      { restoreInTransaction: jest.fn() } as never,
      { awardForDeliveredOrder: jest.fn() } as never,
      { rewardForDeliveredOrder: jest.fn() } as never,
      { openForCancelledOrder: jest.fn().mockResolvedValue(null) } as never,
      audit as never,
      outbox as never,
    );
    return { service, tx, eventEmitter, audit, outbox };
  }

  describe('accepter', () => {
    it('le vendeur accepte : ACCEPTEE, heure d’acceptation et heure de fin annoncée, dans UN updateMany', async () => {
      const { service, tx } = build({});

      await service.acceptOrder('o-1', VENDOR.firebaseUid, 20);

      expect(tx.order.updateMany).toHaveBeenCalledTimes(1);
      expect(tx.order.updateMany).toHaveBeenCalledWith({
        where: { id: 'o-1', status: 'PAYER' },
        data: {
          status: 'ACCEPTEE',
          acceptedAt: NOW,
          estimatedReadyAt: new Date('2026-09-24T12:20:00.000Z'),
        },
      });
      expect(tx.orderHistory.create.mock.calls[0][0].data).toMatchObject({
        fromStatus: 'PAYER',
        toStatus: 'ACCEPTEE',
        actorUserId: VENDOR.id,
      });
    });

    it('prévient le client (même événement que tout changement de statut)', async () => {
      const { service, eventEmitter } = build({});

      await service.acceptOrder('o-1', VENDOR.firebaseUid, 20);

      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'order.status.updated',
        expect.objectContaining({ newStatus: 'ACCEPTEE' }),
      );
    });

    it('précommande : l’acceptation vaut confirmation (un seul geste)', async () => {
      const { service, tx } = build({ isPreorder: true });

      await service.acceptOrder('o-1', VENDOR.firebaseUid, 30);

      expect(
        tx.order.updateMany.mock.calls[0][0].data.preorderConfirmedAt,
      ).toEqual(NOW);
    });

    it('refuse le vendeur d’une autre boutique, sans rien écrire', async () => {
      const { service, tx } = build({ user: OTHER_VENDOR });

      await expect(
        service.acceptOrder('o-1', OTHER_VENDOR.firebaseUid, 20),
      ).rejects.toThrow(ForbiddenException);
      expect(tx.order.updateMany).not.toHaveBeenCalled();
    });

    it('refuse une commande qui n’est plus PAYER', async () => {
      const { service, tx } = build({ status: 'EN_PREPARATION' });

      await expect(
        service.acceptOrder('o-1', VENDOR.firebaseUid, 20),
      ).rejects.toThrow(BadRequestException);
      expect(tx.order.updateMany).not.toHaveBeenCalled();
    });

    it('un ADMIN qui accepte pour le vendeur entre au journal d’audit', async () => {
      const { service, audit } = build({ user: ADMIN });

      await service.acceptOrder('o-1', ADMIN.firebaseUid, 20);

      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'ORDER_STATUS_FORCED',
          targetId: 'o-1',
          metadata: expect.objectContaining({ from: 'PAYER', to: 'ACCEPTEE' }),
        }),
      );
    });
  });

  describe('refuser', () => {
    it('motif écrit AVEC l’annulation, et remboursement dû marqué exécutable sans humain', async () => {
      const { service, tx, outbox } = build({});

      await service.rejectOrder('o-1', VENDOR.firebaseUid, {
        reason: 'OUT_OF_STOCK',
        note: 'Plus de poulet',
      });

      expect(tx.order.updateMany).toHaveBeenCalledWith({
        where: { id: 'o-1', status: 'PAYER' },
        data: {
          status: 'ANNULER',
          vendorRejectionReason: 'OUT_OF_STOCK',
          vendorRejectionNote: 'Plus de poulet',
        },
      });
      expect(tx.orderHistory.create.mock.calls[0][0].data.reason).toContain(
        'OUT_OF_STOCK',
      );
      expect(outbox.enqueueInTransaction).toHaveBeenCalledWith(
        tx,
        expect.objectContaining({
          type: 'order.refund_due',
          payload: expect.objectContaining({ vendorFault: true }),
        }),
      );
    });

    it('fonctionne aussi après acceptation (rupture découverte en cuisine)', async () => {
      const { service, tx } = build({ status: 'ACCEPTEE' });

      await service.rejectOrder('o-1', VENDOR.firebaseUid, {
        reason: 'OUT_OF_STOCK',
      });

      expect(tx.order.updateMany.mock.calls[0][0].where).toEqual({
        id: 'o-1',
        status: 'ACCEPTEE',
      });
    });
  });

  describe('route de statut', () => {
    it('refuse ACCEPTEE comme cible : le seul chemin exige un temps de préparation', async () => {
      const { service, tx } = build({});

      await expect(
        service.updateOrderStatusByRestaurateur(
          'o-1',
          VENDOR.firebaseUid,
          'ACCEPTEE',
        ),
      ).rejects.toThrow(BadRequestException);
      expect(tx.order.updateMany).not.toHaveBeenCalled();
    });

    it('interrupteur allumé : PAYER → EN_PREPARATION refusé, il faut accepter', async () => {
      const { service, tx } = build({ acceptanceRequired: true });

      await expect(
        service.updateOrderStatusByRestaurateur(
          'o-1',
          VENDOR.firebaseUid,
          'EN_PREPARATION',
        ),
      ).rejects.toThrow(BadRequestException);
      expect(tx.order.updateMany).not.toHaveBeenCalled();
    });

    it('interrupteur éteint : PAYER → EN_PREPARATION vaut acceptation implicite', async () => {
      const { service, tx } = build({ acceptanceRequired: false });

      await service.updateOrderStatusByRestaurateur(
        'o-1',
        VENDOR.firebaseUid,
        'EN_PREPARATION',
      );

      expect(tx.order.updateMany).toHaveBeenCalledWith({
        where: { id: 'o-1', status: 'PAYER' },
        data: { status: 'EN_PREPARATION', acceptedAt: NOW },
      });
    });
  });

  describe('DTO', () => {
    it.each([[4], [121], [12.5]])(
      'temps de préparation %s refusé',
      async (prepMinutes) => {
        const errors = await validate(
          plainToInstance(AcceptOrderDto, { prepMinutes }),
        );
        expect(errors).not.toHaveLength(0);
      },
    );

    it('temps de préparation 20 accepté', async () => {
      expect(
        await validate(plainToInstance(AcceptOrderDto, { prepMinutes: 20 })),
      ).toHaveLength(0);
    });

    it('un refus exige un motif de la liste fermée', async () => {
      expect(
        await validate(plainToInstance(RejectOrderDto, {})),
      ).not.toHaveLength(0);
      expect(
        await validate(
          plainToInstance(RejectOrderDto, { reason: 'PARCE_QUE' }),
        ),
      ).not.toHaveLength(0);
    });

    it('la note est bornée', async () => {
      const errors = await validate(
        plainToInstance(RejectOrderDto, {
          reason: 'OTHER',
          note: 'x'.repeat(201),
        }),
      );
      expect(errors).not.toHaveLength(0);
    });
  });
});
