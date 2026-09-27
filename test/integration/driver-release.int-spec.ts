import { PrismaPg } from '@prisma/adapter-pg';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  DeliveryFailureReason,
  DeliveryStatus,
  DriverStatus,
  OrderStatus,
  PrismaClient,
  Role,
  StatusUser,
} from '@prisma/client';

import { DeliveriesService } from '../../apps/lilia-app/src/modules/deliveries/deliveries.service';
import { DeliveryAssignmentLogService } from '../../apps/lilia-app/src/modules/deliveries/delivery-assignment-log.service';
import { DeliveryAssignmentService } from '../../apps/lilia-app/src/modules/deliveries/delivery-assignment.service';
import { DeliveryFailureService } from '../../apps/lilia-app/src/modules/deliveries/delivery-failure.service';
import { DeliveryQueryService } from '../../apps/lilia-app/src/modules/deliveries/delivery-query.service';
import { DriversService } from '../../apps/lilia-app/src/modules/drivers/drivers.service';
import { DeliveriesListener } from '../../apps/lilia-app/src/modules/listeners/deliveries.listener';
import { OrderStateMachine } from '../../apps/lilia-app/src/modules/orders/order-state.machine';
import { OrderTransitionService } from '../../apps/lilia-app/src/modules/orders/order-transition.service';
import { PlatformSettingsService } from '../../apps/lilia-app/src/modules/platform-settings/platform-settings.service';
import { lockDriverRow } from '../../apps/lilia-app/src/modules/drivers/driver-row-lock';
import {
  holdTransaction,
  isDeadlock,
  rejections,
  waitUntilBlocked,
} from './support/lock-interleaving';

/**
 * **F3-12.1 — gate R5 : libération du livreur (PostgreSQL réel).**
 *
 * Invariant : `driverStatus = ON_DELIVERY` ⇔ le livreur porte une course
 * `ACCEPTER` ou `EN_TRANSIT`.
 *
 * Il était violé SANS aucune concurrence. L'assignation empilée est permise
 * (un livreur en course reste assignable, décision Q1 du 27/09/2026) ; or les
 * cinq chemins de libération repassaient le livreur `AVAILABLE` sans regarder
 * s'il portait encore une autre course. Refuser, échouer, réassigner ou
 * annuler la SECONDE course libérait donc un livreur en pleine première
 * course — candidat, demain, à une offre de dispatch.
 *
 * Les événements sont branchés sur le vrai `DeliveriesListener` : la
 * libération best-effort qu'il portait fait partie du défaut.
 *
 * Se saute proprement sans `TEST_DATABASE_URL`.
 */
const DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;
const REPS = Number(process.env.F312_REPS ?? 50);

jest.setTimeout(120_000);

describeIfDb('F3-12.1 R5 — libération du livreur (PostgreSQL réel)', () => {
  let prisma: PrismaClient;
  let assignment: DeliveryAssignmentService;
  let deliveries: DeliveriesService;
  let failures: DeliveryFailureService;
  let drivers: DriversService;
  const transitions = new OrderTransitionService();
  const eventEmitter = new EventEmitter2();
  const pending: Promise<unknown>[] = [];

  const OWNER = 'r5-owner';
  const OWNER_UID = 'fb-r5-owner';
  const ADMIN = 'r5-admin';
  const ADMIN_UID = 'fb-r5-admin';
  const CLIENT = 'r5-client';
  const A = 'r5-driver-a';
  const A_UID = 'fb-r5-a';
  const B = 'r5-driver-b';
  const B_UID = 'fb-r5-b';
  const VENDOR = 'r5-vendor';
  /** Course que A porte réellement (acceptée). */
  const Z = 'r5-z';
  /** Seconde course, empilée sur A. */
  const X = 'r5-x';
  /** Troisième course, pour les assignations concurrentes. */
  const W = 'r5-w';
  const ORDERS = [Z, X, W];
  const order = (d: string) => `${d}-order`;

  /** Attend la fin de tous les gestionnaires d'événements lancés. */
  const settle = async () => {
    while (pending.length) {
      await Promise.allSettled(pending.splice(0));
    }
  };

  const reset = async () => {
    await settle();
    await prisma.incident.deleteMany({});
    await prisma.deliveryFailureReport.deleteMany({});
    await prisma.deliveryAssignment.deleteMany({});
    await prisma.deliveryHandover.deleteMany({});
    await prisma.orderHistory.deleteMany({});
    await prisma.delivery.updateMany({
      data: {
        delivererId: null,
        status: DeliveryStatus.EN_ATTENTE,
        acceptedAt: null,
        pickedUpAt: null,
        deliveredAt: null,
        failedAt: null,
        handoverMethod: null,
        handoverVerifiedAt: null,
        driverBaseXaf: null,
        driverEmploymentType: null,
        driverCompensationModel: null,
        driverSharePercent: null,
        driverPayXaf: null,
        driverEconomicsFrozenAt: null,
      },
    });
    await prisma.order.updateMany({
      data: {
        status: OrderStatus.PRET,
        deliveryProof: null,
        deliveredAt: null,
        payoutDueAt: null,
        customerConfirmedAt: null,
      },
    });
    await prisma.user.updateMany({
      where: { id: { in: [A, B] } },
      data: {
        driverStatus: DriverStatus.AVAILABLE,
        statusUser: StatusUser.ACTIVE,
        role: Role.LIVREUR,
      },
    });
    await prisma.driverProfile.updateMany({
      where: { userId: { in: [A, B] } },
      data: { isActive: true, deactivationReason: null },
    });
  };

  /** La course porte `driverId` au statut donné, avec sa main ouverte au journal. */
  const give = async (
    delivery: string,
    driverId: string,
    status: DeliveryStatus,
  ) => {
    await prisma.delivery.update({
      where: { id: delivery },
      data: { delivererId: driverId, status },
    });
    await prisma.deliveryAssignment.create({
      data: {
        deliveryId: delivery,
        orderId: order(delivery),
        delivererId: driverId,
        assignedByUserId: ADMIN,
        assignedByRole: 'ADMIN',
      },
    });
    if (status === DeliveryStatus.EN_TRANSIT) {
      await prisma.order.update({
        where: { id: order(delivery) },
        data: { status: OrderStatus.EN_ROUTE },
      });
    }
    if (
      status === DeliveryStatus.ACCEPTER ||
      status === DeliveryStatus.EN_TRANSIT
    ) {
      await prisma.user.update({
        where: { id: driverId },
        data: { driverStatus: DriverStatus.ON_DELIVERY },
      });
    }
  };

  /** A porte Z (acceptée) ET X lui est confiée (empilée). */
  const stacked = async (z: DeliveryStatus = DeliveryStatus.ACCEPTER) => {
    await give(Z, A, z);
    await give(X, A, DeliveryStatus.ASSIGNER);
  };

  /** Invariant R5, lu en base. */
  const expectConsistent = async (driverId: string) => {
    const [user, busy] = await Promise.all([
      prisma.user.findUniqueOrThrow({ where: { id: driverId } }),
      prisma.delivery.count({
        where: {
          delivererId: driverId,
          status: { in: [DeliveryStatus.ACCEPTER, DeliveryStatus.EN_TRANSIT] },
        },
      }),
    ]);
    // Libre : disponible ou hors ligne, jamais « en course » — et l'inverse.
    expect({
      driver: driverId,
      busy: busy > 0,
      onDelivery: user.driverStatus === DriverStatus.ON_DELIVERY,
    }).toEqual({ driver: driverId, busy: busy > 0, onDelivery: busy > 0 });
  };

  const statusOf = async (driverId: string) =>
    (await prisma.user.findUniqueOrThrow({ where: { id: driverId } }))
      .driverStatus;

  const expectOnlyBusinessRefusals = (
    results: PromiseSettledResult<unknown>[],
  ) => {
    for (const err of rejections(results)) {
      expect(isDeadlock(err)).toBe(false);
      expect(
        err instanceof ConflictException ||
          err instanceof BadRequestException ||
          err instanceof ForbiddenException ||
          err instanceof NotFoundException,
      ).toBe(true);
    }
  };

  const userRow = (id: string) =>
    prisma.user.findUniqueOrThrow({ where: { id } });

  // ─── Montage ─────────────────────────────────────────────────────────────

  beforeAll(async () => {
    prisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: DATABASE_URL }),
    });
    await prisma.$connect();

    const assignmentLog = new DeliveryAssignmentLogService();
    const stateMachine = new OrderStateMachine();
    const noPush = { sendPushNotification: async () => undefined };
    assignment = new DeliveryAssignmentService(
      prisma as never,
      eventEmitter,
      stateMachine,
      transitions,
      new PlatformSettingsService(prisma as never),
      assignmentLog,
      { forgetLastPosition: async () => undefined } as never,
    );
    deliveries = new DeliveriesService(
      prisma as never,
      noPush as never,
      eventEmitter,
      stateMachine,
      transitions,
      {} as never,
      { forgetLastPosition: async () => undefined } as never,
      new DeliveryQueryService(prisma as never, assignmentLog),
      assignment,
      { awardForDeliveredOrder: async () => undefined } as never,
      { rewardForDeliveredOrder: async () => undefined } as never,
      assignmentLog,
      { enqueueInTransaction: async () => undefined } as never,
      { record: async () => undefined } as never,
    );
    failures = new DeliveryFailureService(
      prisma as never,
      transitions,
      assignmentLog,
      { record: async () => undefined } as never,
      {} as never,
      noPush as never,
      eventEmitter,
    );
    drivers = new DriversService(
      prisma as never,
      {} as never,
      { record: async () => undefined } as never,
      {} as never,
      {} as never,
    );

    // Le VRAI listener, branché comme en production (@OnEvent).
    const listener = new DeliveriesListener(
      noPush as never,
      { create: async () => ({}) } as never,
      prisma as never,
      assignmentLog,
    );
    const track =
      <E>(handler: (e: E) => Promise<unknown>) =>
      (e: E) => {
        pending.push(handler.call(listener, e));
      };
    eventEmitter.on('delivery.assigned', track(listener.handleAssigned));
    eventEmitter.on('delivery.unassigned', track(listener.handleUnassigned));
    eventEmitter.on('delivery.failed', track(listener.handleFailed));
    eventEmitter.on('order.cancelled', track(listener.handleOrderCancelled));

    await prisma.$executeRawUnsafe(`
      TRUNCATE TABLE "Incident", "DeliveryFailureReport", "DeliveryAssignment",
                     "DeliveryHandover", "DeliveryReview", "DeliveryLocation",
                     "Delivery", "OrderItem", "OrderHistory", "Order",
                     "DriverProfile", "Restaurant", "User"
      RESTART IDENTITY CASCADE
    `);

    await prisma.user.createMany({
      data: [
        { id: CLIENT, firebaseUid: 'fb-r5-c', email: 'r5-c@test.local' },
        {
          id: OWNER,
          firebaseUid: OWNER_UID,
          email: 'r5-o@test.local',
          role: 'RESTAURATEUR',
        },
        {
          id: ADMIN,
          firebaseUid: ADMIN_UID,
          email: 'r5-adm@test.local',
          role: 'ADMIN',
        },
        {
          id: A,
          firebaseUid: A_UID,
          email: 'r5-a@test.local',
          nom: 'Livreur A',
          role: 'LIVREUR',
          driverStatus: 'AVAILABLE',
        },
        {
          id: B,
          firebaseUid: B_UID,
          email: 'r5-b@test.local',
          nom: 'Livreur B',
          role: 'LIVREUR',
          driverStatus: 'AVAILABLE',
        },
      ],
    });
    await prisma.driverProfile.createMany({
      data: [A, B].map((userId) => ({
        userId,
        vehicleType: 'MOTO' as const,
        isActive: true,
        employmentType: 'LILIA' as const,
        compensationModel: 'PER_DELIVERY' as const,
      })),
    });
    await prisma.restaurant.create({
      data: {
        id: VENDOR,
        nom: 'Chez R5',
        adresse: 'Poto-Poto',
        phone: '060000005',
        ownerId: OWNER,
      },
    });
    await prisma.order.createMany({
      data: ORDERS.map((d) => ({
        id: order(d),
        restaurantId: VENDOR,
        userId: CLIENT,
        subTotal: 5000,
        deliveryFee: 1000,
        deliveryFeeGross: 1000,
        serviceFee: 750,
        total: 6750,
        paymentMethod: 'MTN_MOMO' as const,
        status: OrderStatus.PRET,
        isDelivery: true,
      })),
    });
    await prisma.delivery.createMany({
      data: ORDERS.map((d) => ({
        id: d,
        orderId: order(d),
        status: DeliveryStatus.EN_ATTENTE,
      })),
    });
  });

  afterAll(async () => {
    await settle();
    await prisma.$disconnect();
  });

  beforeEach(reset);

  // ═════════════════════════════════════════════════════════════════════════
  // 1. Régressions déterministes — AUCUNE concurrence
  // ═════════════════════════════════════════════════════════════════════════

  describe('1 — la fin de la course empilée ne libère pas un livreur en course', () => {
    it('refus de X par A : A reste ON_DELIVERY (il porte Z)', async () => {
      await stacked();
      await deliveries.declineDelivery(X, A_UID, 'trop loin');
      await settle();
      expect(await statusOf(A)).toBe(DriverStatus.ON_DELIVERY);
      await expectConsistent(A);
    });

    it('échec de X déclaré par le vendeur (updateStatus) : A reste ON_DELIVERY', async () => {
      await stacked();
      await deliveries.updateStatus(
        X,
        DeliveryStatus.ECHEC as never,
        OWNER_UID,
        'annulé',
      );
      await settle();
      expect(await statusOf(A)).toBe(DriverStatus.ON_DELIVERY);
      await expectConsistent(A);
    });

    it('échec de X déclaré par le vendeur (F3-05 declare) : A reste ON_DELIVERY', async () => {
      await stacked();
      await failures.declare(X, await userRow(OWNER), {
        reason: DeliveryFailureReason.DRIVER_NO_SHOW,
      });
      await settle();
      expect(await statusOf(A)).toBe(DriverStatus.ON_DELIVERY);
      await expectConsistent(A);
    });

    it('réassignation de X de A vers B : A reste ON_DELIVERY', async () => {
      await stacked();
      await assignment.assignDeliverer(X, B, ADMIN_UID);
      await settle();
      expect(await statusOf(A)).toBe(DriverStatus.ON_DELIVERY);
      await expectConsistent(A);
    });

    it('annulation de la commande de X : A reste ON_DELIVERY', async () => {
      await stacked();
      await prisma.$transaction((tx) =>
        transitions.transition(tx, {
          orderId: order(X),
          from: OrderStatus.PRET,
          to: OrderStatus.ANNULER,
          actor: 'ADMIN',
          actorUserId: ADMIN,
          source: 'ADMIN_APP',
        }),
      );
      eventEmitter.emit('order.cancelled', {
        orderId: order(X),
        restaurantId: VENDOR,
      });
      await settle();
      expect(await statusOf(A)).toBe(DriverStatus.ON_DELIVERY);
      await expectConsistent(A);
      // La course X est bien fermée, et détachée de A.
      const x = await prisma.delivery.findUniqueOrThrow({ where: { id: X } });
      expect(x.status).toBe(DeliveryStatus.ECHEC);
      expect(x.delivererId).toBeNull();
    });
  });

  describe('1b — la libération légitime fonctionne toujours', () => {
    it('LIVRER de la seule course : A redevient AVAILABLE', async () => {
      await give(Z, A, DeliveryStatus.EN_TRANSIT);
      await deliveries.updateStatus(
        Z,
        DeliveryStatus.LIVRER as never,
        ADMIN_UID,
        undefined,
      );
      await settle();
      expect(await statusOf(A)).toBe(DriverStatus.AVAILABLE);
    });

    it('échec de la seule course acceptée (livreur) : A redevient AVAILABLE', async () => {
      await give(Z, A, DeliveryStatus.ACCEPTER);
      await failures.declare(Z, await userRow(A), {
        reason: DeliveryFailureReason.OTHER,
      });
      await settle();
      expect(await statusOf(A)).toBe(DriverStatus.AVAILABLE);
    });

    it('réassignation de la seule course acceptée : A redevient AVAILABLE', async () => {
      await give(Z, A, DeliveryStatus.ACCEPTER);
      await assignment.assignDeliverer(Z, B, ADMIN_UID);
      await settle();
      expect(await statusOf(A)).toBe(DriverStatus.AVAILABLE);
    });

    it('A passé OFFLINE (réparation) n’est jamais réactivé par une libération', async () => {
      await give(X, A, DeliveryStatus.ASSIGNER);
      await prisma.user.update({
        where: { id: A },
        data: { driverStatus: DriverStatus.OFFLINE },
      });
      await deliveries.declineDelivery(X, A_UID);
      await settle();
      expect(await statusOf(A)).toBe(DriverStatus.OFFLINE);
    });

    it('compte non ACTIVE à la clôture : OFFLINE, jamais AVAILABLE', async () => {
      await give(Z, A, DeliveryStatus.EN_TRANSIT);
      await prisma.user.update({
        where: { id: A },
        data: { statusUser: StatusUser.BLOCKED },
      });
      await deliveries.updateStatus(
        Z,
        DeliveryStatus.LIVRER as never,
        ADMIN_UID,
      );
      await settle();
      expect(await statusOf(A)).toBe(DriverStatus.OFFLINE);
    });
  });

  // ═════════════════════════════════════════════════════════════════════════
  // 2. Concurrence — ×REPS, 0 interblocage, invariant à chaque tour
  // ═════════════════════════════════════════════════════════════════════════

  describe('2 — courses concurrentes', () => {
    /**
     * Contrat du verrou R4 de `releaseDriverIfIdle`.
     *
     * Aujourd'hui, tout geste qui rend un livreur « en course » exige d'abord
     * `AVAILABLE` : aucun chemin réel ne peut donc s'intercaler ici, et un
     * test de bout en bout ne verrait pas l'absence du verrou (mutant M-R5a
     * survivant). Le contrat, lui, est que la décision « il ne porte plus
     * rien » soit prise SOUS le verrou du livreur : un écrivain qui le tient
     * et lui confie une course doit être vu. Le dernier `UPDATE` est bien un
     * CAS, mais sur `driverStatus`, pas sur les courses portées.
     */
    it('entrelacement forcé : la libération attend un écrivain qui tient R4, puis voit sa course', async () => {
      await give(Z, A, DeliveryStatus.EN_TRANSIT);
      const writer = await holdTransaction(prisma, async (tx) => {
        await lockDriverRow(tx, A);
        await tx.delivery.update({
          where: { id: W },
          data: { delivererId: A, status: DeliveryStatus.ACCEPTER },
        });
      });

      const closing = deliveries.updateStatus(
        Z,
        DeliveryStatus.LIVRER as never,
        ADMIN_UID,
      );
      closing.catch(() => undefined);
      await waitUntilBlocked(prisma);
      await writer.commit();
      await closing;
      await settle();

      expect(await statusOf(A)).toBe(DriverStatus.ON_DELIVERY);
      await expectConsistent(A);
    });

    it(`release ∥ accept ×${REPS} : A livre Z pendant qu’il accepte X`, async () => {
      for (let i = 0; i < REPS; i++) {
        await reset();
        await stacked(DeliveryStatus.EN_TRANSIT);
        const results = await Promise.allSettled([
          deliveries.updateStatus(Z, DeliveryStatus.LIVRER as never, ADMIN_UID),
          assignment.acceptDelivery(X, A_UID),
        ]);
        await settle();
        expectOnlyBusinessRefusals(results);
        await expectConsistent(A);
      }
    });

    it(`release ∥ deactivate ×${REPS} : jamais inactif et AVAILABLE`, async () => {
      for (let i = 0; i < REPS; i++) {
        await reset();
        await give(Z, A, DeliveryStatus.EN_TRANSIT);
        const results = await Promise.allSettled([
          deliveries.updateStatus(Z, DeliveryStatus.LIVRER as never, ADMIN_UID),
          drivers.deactivate(A, { reason: 'test' }, ADMIN),
        ]);
        await settle();
        expectOnlyBusinessRefusals(results);
        await expectConsistent(A);
        const profile = await prisma.driverProfile.findUniqueOrThrow({
          where: { userId: A },
        });
        if (!profile.isActive) {
          expect(await statusOf(A)).toBe(DriverStatus.OFFLINE);
        }
      }
    });

    it(`release ∥ assign ×${REPS} : refus de X pendant qu’on lui confie W`, async () => {
      for (let i = 0; i < REPS; i++) {
        await reset();
        await stacked();
        const results = await Promise.allSettled([
          deliveries.declineDelivery(X, A_UID),
          assignment.assignDeliverer(W, A, OWNER_UID),
        ]);
        await settle();
        expectOnlyBusinessRefusals(results);
        await expectConsistent(A);
        expect(await statusOf(A)).toBe(DriverStatus.ON_DELIVERY);
      }
    });

    it(`release ∥ LIVRER ×${REPS} : refus de X pendant la livraison de Z`, async () => {
      for (let i = 0; i < REPS; i++) {
        await reset();
        await stacked(DeliveryStatus.EN_TRANSIT);
        const results = await Promise.allSettled([
          deliveries.declineDelivery(X, A_UID),
          deliveries.updateStatus(Z, DeliveryStatus.LIVRER as never, ADMIN_UID),
        ]);
        await settle();
        expectOnlyBusinessRefusals(results);
        await expectConsistent(A);
      }
    });

    it(`réassignations croisées A↔B ×${REPS} : 0 interblocage`, async () => {
      for (let i = 0; i < REPS; i++) {
        await reset();
        await give(Z, A, DeliveryStatus.ACCEPTER);
        await give(X, B, DeliveryStatus.ACCEPTER);
        const results = await Promise.allSettled([
          assignment.assignDeliverer(Z, B, ADMIN_UID),
          assignment.assignDeliverer(X, A, ADMIN_UID),
        ]);
        await settle();
        expectOnlyBusinessRefusals(results);
        await expectConsistent(A);
        await expectConsistent(B);
      }
    });
  });
});
