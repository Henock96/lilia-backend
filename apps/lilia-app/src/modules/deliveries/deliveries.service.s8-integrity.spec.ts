import { AdminAuditService } from '../admin-audit/admin-audit.service';
import { OutboxService } from '../outbox/outbox.service';
import { Test, TestingModule } from '@nestjs/testing';
import { ConflictException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { DeliveriesService } from './deliveries.service';
import { DeliveryQueryService } from './delivery-query.service';
import { DeliveryAssignmentService } from './delivery-assignment.service';
import { DeliveryAssignmentLogService } from './delivery-assignment-log.service';
import { DeliveryStatus } from './dto/update-delivery.dto';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { OrderStateMachine } from '../orders/order-state.machine';
import { OrderTransitionService } from '../orders/order-transition.service';
import { TrackingGateway } from '../tracking/tracking.gateway';
import { TrackingService } from '../tracking/tracking.service';
import { LoyaltyService } from '../loyalty/loyalty.service';
import { ReferralService } from '../users/referral.service';

/**
 * S8 — une livraison ne peut plus se clôturer sur une commande qui n'a pas suivi.
 *
 * ## Le défaut
 *
 * `updateStatus` construisait un tableau d'opérations passé à
 * `$transaction([...])`, dont le résultat n'était **jamais lu**. Le verrou
 * optimiste sur la commande était donc posé — `updateMany WHERE status = <lu>` —
 * et son `count` jeté. Quand la commande bougeait entre la lecture et
 * l'écriture (annulation ADMIN concurrente), on obtenait :
 *
 *   Delivery = LIVRER   ·   Order ≠ LIVRER
 *
 * et pourtant : l'événement `order.status.updated` partait avec
 * `toStatus = LIVRER`, le client recevait « 🎉 Commande livrée » sur une
 * commande annulée, les points de fidélité et la récompense de parrainage
 * étaient crédités, et la commande devenait éligible au reversement vendeur.
 *
 * ## Ce que ces tests exigent
 *
 * Le contrôle est **dans** la transaction. Si la commande n'a pas bougé : 409,
 * rollback, et **aucun** effet de bord.
 */
describe('DeliveriesService.updateStatus — intégrité livraison/commande (S8)', () => {
  let service: DeliveriesService;
  let loyalty: { awardForDeliveredOrder: jest.Mock };
  let referral: { rewardForDeliveredOrder: jest.Mock };
  let emitter: { emit: jest.Mock };

  /** État simulé de la base, partagé par le mock de transaction. */
  let orderStatus: string;
  let deliveryStatus: DeliveryStatus;
  /** Écritures réellement appliquées — vidées si la transaction est annulée. */
  let applied: string[];

  const DELIVERY_ID = 'del-1';
  const ORDER_ID = 'o-1';
  const DRIVER = {
    id: 'u-livreur',
    firebaseUid: 'fb-livreur',
    role: 'LIVREUR',
  };

  let deliveryUpdates: Record<string, unknown>[] = [];
  /** `data` de chaque clôture de main : c'est là que vit l'issue de la course. */
  let assignmentCloses: Record<string, unknown>[] = [];
  const prisma = {
    delivery: { findUnique: jest.fn(), update: jest.fn() },
    user: { findUnique: jest.fn(), update: jest.fn() },
    // Course sans code (récupérée avant F-06) : conclusion `UNVERIFIED`.
    deliveryHandover: { findUnique: jest.fn().mockResolvedValue(null) },
    order: { updateMany: jest.fn() },
    orderHistory: { create: jest.fn() },
    // Journal d'assignation : ouvert et clos dans la même transaction que le
    // statut de la livraison.
    deliveryAssignment: { create: jest.fn(), updateMany: jest.fn() },
    $transaction: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    orderStatus = 'EN_ROUTE';
    deliveryStatus = DeliveryStatus.EN_TRANSIT;
    applied = [];
    deliveryUpdates = [];
    assignmentCloses = [];

    // Transaction interactive simulée : les écritures s'accumulent dans
    // `applied`, et une exception les annule toutes — comme le ferait
    // PostgreSQL.
    const tx = {
      delivery: {
        updateMany: jest.fn(
          ({
            where,
            data,
          }: {
            where: { status: DeliveryStatus };
            data: Record<string, unknown>;
          }) => {
            if (where.status !== deliveryStatus) {
              return Promise.resolve({ count: 0 });
            }
            applied.push('delivery');
            // On garde le `data` écrit : c'est lui qui porte l'effacement de
            // l'économie de la course, invisible d'un simple compteur.
            deliveryUpdates.push(data);
            return Promise.resolve({ count: 1 });
          },
        ),
      },
      order: {
        updateMany: jest.fn(
          ({
            where,
            data,
          }: {
            where: { status: string };
            data: { status: string };
          }) => {
            if (where.status !== orderStatus) {
              return Promise.resolve({ count: 0 });
            }
            orderStatus = data.status;
            applied.push('order');
            return Promise.resolve({ count: 1 });
          },
        ),
      },
      orderHistory: {
        create: jest.fn(() => {
          applied.push('history');
          return Promise.resolve({});
        }),
      },
      user: {
        update: jest.fn(() => {
          applied.push('driver');
          return Promise.resolve({});
        }),
      },
      // Journal d'assignation : la clôture de la main courante appartient à la
      // même transaction que la clôture de la course.
      deliveryAssignment: {
        create: jest.fn(() => {
          applied.push('assignment-open');
          return Promise.resolve({});
        }),
        updateMany: jest.fn(({ data }: { data: Record<string, unknown> }) => {
          applied.push('assignment-close');
          assignmentCloses.push(data);
          return Promise.resolve({ count: 1 });
        }),
      },
    };

    prisma.$transaction.mockImplementation(async (arg: unknown) => {
      const snapshotOrder = orderStatus;
      try {
        return await (arg as (t: unknown) => Promise<unknown>)(tx);
      } catch (err) {
        // Rollback : on remet l'état d'avant et on jette les écritures.
        orderStatus = snapshotOrder;
        applied = [];
        deliveryUpdates = [];
        assignmentCloses = [];
        throw err;
      }
    });

    prisma.delivery.findUnique.mockResolvedValue({
      id: DELIVERY_ID,
      orderId: ORDER_ID,
      delivererId: DRIVER.id,
      get status() {
        return deliveryStatus;
      },
      order: {
        id: ORDER_ID,
        userId: 'u-client',
        restaurantId: 'r-1',
        total: 5320,
        get status() {
          return orderStatus;
        },
        restaurant: { nom: 'Chez Lili', owner: { firebaseUid: 'fb-vendeur' } },
      },
      deliverer: DRIVER,
    });
    prisma.user.findUnique.mockResolvedValue(DRIVER);

    loyalty = {
      awardForDeliveredOrder: jest.fn().mockResolvedValue(undefined),
    };
    referral = {
      rewardForDeliveredOrder: jest.fn().mockResolvedValue(undefined),
    };
    emitter = { emit: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        // Journal d'audit : conclusion d'une course par un ADMIN (F-06).
        { provide: AdminAuditService, useValue: { record: jest.fn() } },
        // Obligations durables écrites dans la transaction `LIVRER` (lot 4).
        {
          provide: OutboxService,
          useValue: { enqueueInTransaction: jest.fn() },
        },
        DeliveriesService,
        OrderStateMachine,
        OrderTransitionService,
        { provide: PrismaService, useValue: prisma },
        // Service réel : le journal d'assignation s'écrit dans la même
        // transaction que le statut, ses écritures doivent être exercées.
        DeliveryAssignmentLogService,
        { provide: EventEmitter2, useValue: emitter },
        { provide: LoyaltyService, useValue: loyalty },
        { provide: ReferralService, useValue: referral },
        {
          provide: NotificationsService,
          useValue: { sendPushNotification: jest.fn() },
        },
        {
          provide: TrackingGateway,
          useValue: { broadcastOrderStatus: jest.fn() },
        },
        {
          provide: TrackingService,
          useValue: {
            cacheLivePosition: jest.fn(),
            forgetLastPosition: jest.fn().mockResolvedValue(undefined),
          },
        },
        { provide: DeliveryQueryService, useValue: {} },
        { provide: DeliveryAssignmentService, useValue: {} },
      ],
    }).compile();

    service = module.get(DeliveriesService);
  });

  const markDelivered = () =>
    service.updateStatus(
      DELIVERY_ID,
      DeliveryStatus.LIVRER,
      DRIVER.firebaseUid,
    );

  describe('cas nominal', () => {
    it('clôture la livraison, la commande, et écrit l’historique', async () => {
      await markDelivered();

      expect(orderStatus).toBe('LIVRER');
      expect(applied).toEqual(
        expect.arrayContaining(['delivery', 'order', 'history', 'driver']),
      );
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    });

    it('émet la notification et crédite les récompenses', async () => {
      await markDelivered();

      const statusEvents = emitter.emit.mock.calls.filter(
        ([name]) => name === 'order.status.updated',
      );
      expect(statusEvents).toHaveLength(1);
      expect(loyalty.awardForDeliveredOrder).toHaveBeenCalledTimes(1);
      expect(referral.rewardForDeliveredOrder).toHaveBeenCalledTimes(1);
    });
  });

  describe('commande modifiée en concurrence — LE défaut S8', () => {
    beforeEach(() => {
      // Le livreur a lu la commande en `EN_ROUTE`. Un ADMIN l'annule pendant
      // qu'il appuie sur « Livré ».
      prisma.$transaction.mockImplementationOnce(async (arg: unknown) => {
        orderStatus = 'ANNULER';
        const snapshot = orderStatus;
        try {
          return await (arg as (t: unknown) => Promise<unknown>)(
            await buildTxForConcurrentChange(),
          );
        } catch (err) {
          orderStatus = snapshot;
          applied = [];
          deliveryUpdates = [];
          throw err;
        }
      });
    });

    /** Transaction dont le claim de commande échoue, l'état ayant changé. */
    async function buildTxForConcurrentChange() {
      return {
        delivery: {
          updateMany: jest.fn(() => {
            applied.push('delivery');
            return Promise.resolve({ count: 1 });
          }),
        },
        // `EN_ROUTE` attendu, `ANNULER` réel ⇒ 0 ligne.
        order: { updateMany: jest.fn(() => Promise.resolve({ count: 0 })) },
        orderHistory: {
          create: jest.fn(() => {
            applied.push('history');
            return Promise.resolve({});
          }),
        },
        user: {
          update: jest.fn(() => {
            applied.push('driver');
            return Promise.resolve({});
          }),
        },
      };
    }

    it('répond 409 au lieu de clôturer en silence', async () => {
      await expect(markDelivered()).rejects.toBeInstanceOf(ConflictException);
    });

    it('n’écrit RIEN : ni livraison, ni commande, ni historique', async () => {
      await expect(markDelivered()).rejects.toThrow();
      expect(applied).toEqual([]);
      expect(orderStatus).toBe('ANNULER');
    });

    it('n’envoie AUCUNE notification « commande livrée »', async () => {
      await expect(markDelivered()).rejects.toThrow();
      const statusEvents = emitter.emit.mock.calls.filter(
        ([name]) => name === 'order.status.updated',
      );
      expect(statusEvents).toHaveLength(0);
    });

    it('ne crédite NI points de fidélité, NI récompense de parrainage', async () => {
      await expect(markDelivered()).rejects.toThrow();
      expect(loyalty.awardForDeliveredOrder).not.toHaveBeenCalled();
      expect(referral.rewardForDeliveredOrder).not.toHaveBeenCalled();
    });
  });

  describe('double-tap du livreur', () => {
    it('la seconde requête échoue en 409 — la livraison n’avait pas de verrou', async () => {
      // `updateStatus` écrivait la livraison avec un `update` inconditionnel :
      // deux taps passaient tous les deux. `confirmPickup` posait déjà cette
      // garde, ce chemin non.
      await markDelivered();
      deliveryStatus = DeliveryStatus.LIVRER;

      await expect(markDelivered()).rejects.toThrow();
    });
  });

  describe('échec de livraison (ECHEC)', () => {
    it('efface l’économie de la course en même temps que le livreur', async () => {
      // Le livreur est détaché (`delivererId = null`) : garder son montant
      // laisserait une rémunération sans titulaire sur la course. Et puisque
      // seul celui qui TERMINE est payé, cette tentative n'a pas d'économie.
      // Les deux écritures vont donc ensemble, dans le même `updateMany`.
      await service.updateStatus(
        DELIVERY_ID,
        DeliveryStatus.ECHEC,
        DRIVER.firebaseUid,
        'Client injoignable',
      );

      const data = deliveryUpdates[deliveryUpdates.length - 1];
      expect(data).toMatchObject({
        status: DeliveryStatus.ECHEC,
        delivererId: null,
        driverBaseXaf: null,
        driverEmploymentType: null,
        driverCompensationModel: null,
        driverSharePercent: null,
        driverPayXaf: null,
        driverEconomicsFrozenAt: null,
      });
    });

    it('ne touche pas la commande et n’écrit aucun historique', async () => {
      // Comportement métier inchangé : c'est le vendeur qui arbitre entre
      // réassigner et annuler. Seul le livreur est détaché et libéré.
      await service.updateStatus(
        DELIVERY_ID,
        DeliveryStatus.ECHEC,
        DRIVER.firebaseUid,
        'Client injoignable',
      );

      expect(orderStatus).toBe('EN_ROUTE');
      expect(applied).toContain('delivery');
      expect(applied).toContain('driver');
      expect(applied).not.toContain('history');
    });
  });
});
