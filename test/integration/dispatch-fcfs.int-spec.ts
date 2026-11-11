import { PrismaPg } from '@prisma/adapter-pg';
import { ConflictException, ForbiddenException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  DeliveryAssignmentOutcome,
  DeliveryStatus,
  DispatchOutcome,
  DriverStatus,
  OrderStatus,
  Prisma,
  PrismaClient,
  Role,
  StatusUser,
} from '@prisma/client';

import { DeliveryAssignmentLogService } from '../../apps/lilia-app/src/modules/deliveries/delivery-assignment-log.service';
import { DeliveryAssignmentService } from '../../apps/lilia-app/src/modules/deliveries/delivery-assignment.service';
import { DeliveryClaimService } from '../../apps/lilia-app/src/modules/deliveries/delivery-claim.service';
import { DeliveryDispatchService } from '../../apps/lilia-app/src/modules/deliveries/dispatch/delivery-dispatch.service';
import {
  CLAIM_ERROR,
  DELIVERY_DISPATCH_REQUESTED_EVENT,
  FCFS_MAX_ROUNDS,
  FCFS_ROUND_INTERVAL_MS,
  MANUAL_ASSIGNMENT_DISABLED,
  PUSH_DELIVERY_OFFER,
} from '../../apps/lilia-app/src/modules/deliveries/dispatch/dispatch-policy';
import { lockDriverRow } from '../../apps/lilia-app/src/modules/drivers/driver-row-lock';
import { OpsQueueService } from '../../apps/lilia-app/src/modules/ops/ops-queue.service';
import { lockOrderRow } from '../../apps/lilia-app/src/modules/orders/order-row-lock';
import { OrderStateMachine } from '../../apps/lilia-app/src/modules/orders/order-state.machine';
import { OrderTransitionService } from '../../apps/lilia-app/src/modules/orders/order-transition.service';
import { OutboxService } from '../../apps/lilia-app/src/modules/outbox/outbox.service';
import { PlatformSettingsService } from '../../apps/lilia-app/src/modules/platform-settings/platform-settings.service';
import { holdTransaction, waitUntilBlocked } from './support/lock-interleaving';

/**
 * **Dispatch FCFS — « premier arrivé, premier servi », contre un vrai
 * PostgreSQL** (10/11/2026).
 *
 * Ce que seul un vrai PostgreSQL peut prouver :
 *  - dix claims simultanés sur la même course → UN gagnant, neuf 409 ;
 *  - un claim et une annulation qui se croisent sont sérialisés par le
 *    verrou de la ligne `Order` ;
 *  - un claim et un passage OFFLINE qui se croisent le sont par la ligne
 *    `User` ;
 *  - cinq tours de diffusion lancés en même temps → UNE diffusion (CAS sur
 *    `dispatchRound`).
 *
 * Se saute proprement sans `TEST_DATABASE_URL`.
 */
const DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

type ErrorBody = { code?: string; message?: string };
const codeOf = (err: unknown): string | undefined =>
  (err as { getResponse?: () => ErrorBody }).getResponse?.()?.code;

describeIfDb('Dispatch FCFS (PostgreSQL réel)', () => {
  jest.setTimeout(180_000);

  let prisma: PrismaClient;
  let dispatch: DeliveryDispatchService;
  let claims: DeliveryClaimService;
  let assignment: DeliveryAssignmentService;
  let transitions: OrderTransitionService;
  let ops: OpsQueueService;

  const events = new EventEmitter2();
  const pushes: { userIds: string[]; data?: Record<string, string> }[] = [];
  const notifications = {
    sendPushToUsers: async (
      userIds: string[],
      _t: string,
      _b: string,
      data?: Record<string, string>,
    ) => {
      pushes.push({ userIds, data });
      return { sent: userIds.length, failed: 0, devices: userIds.length };
    },
    sendPushNotification: async () => undefined,
  };

  const CLIENT = 'fcfs-client';
  const OWNER = 'fcfs-owner';
  const OWNER_UID = 'fb-fcfs-owner';
  const ADMIN = 'fcfs-admin';
  const ADMIN_UID = 'fb-fcfs-admin';
  const VENDOR = 'fcfs-vendor';
  const Q_SHOP = 'fcfs-q-shop';
  const Q_OTHER = 'fcfs-q-other';
  const Q_DEST = 'fcfs-q-dest';

  /** Dix livreurs éligibles, toute la ville. */
  const DRIVERS = Array.from({ length: 10 }, (_, i) => `fcfs-d${i}`);
  const uid = (id: string) => `fb-${id}`;
  /** Livreurs exclus, chacun pour une raison. */
  const D_ZONE = 'fcfs-x-zone'; // zone Q_OTHER ≠ boutique
  const D_OFF = 'fcfs-x-off'; // OFFLINE
  const D_NULL = 'fcfs-x-null'; // driverStatus null
  const D_BAN = 'fcfs-x-ban'; // ban programmé
  const D_NOCAP = 'fcfs-x-nocap'; // app ancienne
  const D_STALE = 'fcfs-x-stale'; // capacité trop ancienne (présence)
  const D_INACT = 'fcfs-x-inact'; // profil hors service
  const D_BUSY = 'fcfs-x-busy'; // ON_DELIVERY
  const D_INZONE = 'fcfs-x-inzone'; // zone = celle de la boutique : éligible
  const EXCLUDED = [
    D_ZONE,
    D_OFF,
    D_NULL,
    D_BAN,
    D_NOCAP,
    D_STALE,
    D_INACT,
    D_BUSY,
  ];

  const ORDERS = ['fcfs-o1', 'fcfs-o2', 'fcfs-o3'];
  const [O1, O2, O3] = ORDERS;

  const setEnabled = (dispatchEnabled: boolean) =>
    prisma.platformSettings.update({
      where: { id: 'singleton' },
      data: { dispatchEnabled },
    });

  const delivery = (orderId: string) =>
    prisma.delivery.findUniqueOrThrow({ where: { orderId } });

  const driver = (id: string) =>
    prisma.user.findUniqueOrThrow({ where: { id } });

  /** Passe une commande `EN_PREPARATION → PRET` comme `OrderLifecycleService`. */
  const makeReady = async (orderId: string) =>
    prisma.$transaction(async (tx) => {
      await transitions.transition(tx, {
        orderId,
        from: OrderStatus.EN_PREPARATION,
        to: OrderStatus.PRET,
        actor: 'RESTAURATEUR',
        actorUserId: OWNER,
        source: 'APP',
      });
      return dispatch.openInTransaction(tx, orderId);
    });

  /** Annule une commande `PRET` comme le ferait l'ADMIN. */
  const cancel = (tx: Prisma.TransactionClient, orderId: string) =>
    transitions.transition(tx, {
      orderId,
      from: OrderStatus.PRET,
      to: OrderStatus.ANNULER,
      actor: 'ADMIN',
      actorUserId: ADMIN,
      source: 'ADMIN_APP',
    });

  const claimBy = (orderId: string, driverId: string) =>
    delivery(orderId).then((d) => claims.claim(d.id, uid(driverId)));

  const refusal = async (run: Promise<unknown>) => {
    const err = await run.then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).not.toBeNull();
    return err as Error;
  };

  const reset = async () => {
    pushes.length = 0;
    await prisma.outboxEvent.deleteMany({});
    await prisma.incident.deleteMany({});
    await prisma.deliveryAssignment.deleteMany({});
    await prisma.deliveryHandover.deleteMany({});
    await prisma.orderHistory.deleteMany({});
    await prisma.delivery.deleteMany({});
    await prisma.order.updateMany({
      data: { status: OrderStatus.EN_PREPARATION },
    });
    await prisma.user.updateMany({
      where: { id: { in: [...DRIVERS, D_INZONE] } },
      data: {
        role: Role.LIVREUR,
        statusUser: StatusUser.ACTIVE,
        driverStatus: DriverStatus.AVAILABLE,
        banPendingAt: null,
      },
    });
    await prisma.driverProfile.updateMany({
      where: { userId: { in: [...DRIVERS, D_INZONE] } },
      data: { isActive: true, offersEnabledAt: new Date() },
    });
    await setEnabled(true);
  };

  beforeAll(async () => {
    prisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: DATABASE_URL }),
    });
    await prisma.$connect();

    const outbox = new OutboxService(prisma as never);
    const assignmentLog = new DeliveryAssignmentLogService();
    transitions = new OrderTransitionService();
    const settings = new PlatformSettingsService(prisma as never);
    dispatch = new DeliveryDispatchService(
      prisma as never,
      notifications as never,
      outbox,
      { registerHandler: () => undefined } as never,
      {
        runExclusively: (
          _n: string,
          _t: number,
          task: () => Promise<unknown>,
        ) => task(),
      } as never,
    );
    claims = new DeliveryClaimService(
      prisma as never,
      events,
      settings,
      assignmentLog,
      outbox,
      dispatch,
    );
    assignment = new DeliveryAssignmentService(
      prisma as never,
      events,
      new OrderStateMachine(),
      transitions,
      settings,
      assignmentLog,
      { forgetLastPosition: async () => undefined } as never,
    );
    ops = new OpsQueueService(prisma as never);

    await prisma.$executeRawUnsafe(`
      TRUNCATE TABLE "DeliveryOffer", "Incident", "OutboxEvent",
                     "DeliveryFailureReport", "DeliveryAssignment",
                     "DeliveryHandover", "DeliveryReview", "DeliveryLocation",
                     "Delivery", "OrderItem", "OrderHistory", "Order",
                     "DriverProfile", "Restaurant", "Quartier",
                     "PlatformSettings", "User"
      RESTART IDENTITY CASCADE
    `);
    await prisma.platformSettings.create({
      data: { id: 'singleton', dispatchEnabled: true },
    });
    await prisma.quartier.createMany({
      data: [
        { id: Q_SHOP, nom: 'Poto-Poto (fcfs)' },
        { id: Q_OTHER, nom: 'Talangaï (fcfs)' },
        { id: Q_DEST, nom: 'Moungali (fcfs)' },
      ],
    });
    const allDrivers = [...DRIVERS, ...EXCLUDED, D_INZONE];
    await prisma.user.createMany({
      data: [
        {
          id: CLIENT,
          firebaseUid: uid(CLIENT),
          email: 'fcfs-c@test.local',
          nom: 'Client Secret',
          phone: '+242060000001',
        },
        {
          id: OWNER,
          firebaseUid: OWNER_UID,
          email: 'fcfs-o@test.local',
          role: Role.RESTAURATEUR,
        },
        {
          id: ADMIN,
          firebaseUid: ADMIN_UID,
          email: 'fcfs-a@test.local',
          role: Role.ADMIN,
        },
        ...allDrivers.map((id) => ({
          id,
          firebaseUid: uid(id),
          email: `${id}@test.local`,
          nom: `Livreur ${id}`,
          role: Role.LIVREUR,
          driverStatus:
            id === D_OFF
              ? DriverStatus.OFFLINE
              : id === D_NULL
                ? null
                : id === D_BUSY
                  ? DriverStatus.ON_DELIVERY
                  : DriverStatus.AVAILABLE,
          banPendingAt: id === D_BAN ? new Date() : null,
          banPendingReason: id === D_BAN ? 'test' : null,
        })),
      ],
    });
    const thirteenHoursAgo = new Date(Date.now() - 13 * 3600_000);
    for (const id of allDrivers) {
      await prisma.driverProfile.create({
        data: {
          userId: id,
          vehicleType: 'MOTO',
          isActive: id !== D_INACT,
          employmentType: 'LILIA',
          compensationModel: 'PER_DELIVERY',
          offersEnabledAt:
            id === D_NOCAP
              ? null
              : id === D_STALE
                ? thirteenHoursAgo
                : new Date(),
          ...(id === D_ZONE ? { zones: { connect: { id: Q_OTHER } } } : {}),
          ...(id === D_INZONE ? { zones: { connect: { id: Q_SHOP } } } : {}),
        },
      });
    }
    await prisma.restaurant.create({
      data: {
        id: VENDOR,
        nom: 'Chez FCFS',
        adresse: 'Poto-Poto',
        phone: '060000099',
        ownerId: OWNER,
        quartierId: Q_SHOP,
      },
    });
    await prisma.order.createMany({
      data: ORDERS.map((id, i) => ({
        id,
        restaurantId: VENDOR,
        userId: CLIENT,
        subTotal: 5000,
        deliveryFee: 1000,
        deliveryFeeGross: 1000,
        serviceFee: 750,
        total: 6750,
        paymentMethod: 'MTN_MOMO' as const,
        status: OrderStatus.EN_PREPARATION,
        isDelivery: true,
        deliveryAddress: `Rue secrète ${i}`,
        contactPhone: '+242060000002',
        deliveryQuartierId: Q_DEST,
        createdAt: new Date(Date.now() - (ORDERS.length - i) * 60_000),
      })),
    });
  });

  afterAll(async () => {
    await prisma.platformSettings.updateMany({
      data: { dispatchEnabled: false },
    });
    await prisma.$disconnect();
  });

  beforeEach(reset);

  // ═════════════════════════════════════════════════════════════════════════
  // Ouverture à PRET
  // ═════════════════════════════════════════════════════════════════════════

  describe('ouverture à PRET', () => {
    it('T1 — une livraison qui passe PRET ouvre une recherche, avec son outbox', async () => {
      const opened = await makeReady(O1);
      expect(opened).not.toBeNull();
      const d = await delivery(O1);
      expect(d.status).toBe(DeliveryStatus.EN_ATTENTE);
      expect(d.delivererId).toBeNull();
      expect(d.dispatchStartedAt).not.toBeNull();
      expect(d.dispatchEndedAt).toBeNull();
      expect(d.dispatchRound).toBe(0);
      const ob = await prisma.outboxEvent.findMany({
        where: { type: DELIVERY_DISPATCH_REQUESTED_EVENT },
      });
      expect(ob).toHaveLength(1);
      expect(ob[0].aggregateId).toBe(d.id);
    });

    it('T3 — une course déjà attribuée avant PRET ne rouvre rien', async () => {
      await prisma.delivery.create({
        data: {
          orderId: O1,
          status: DeliveryStatus.ASSIGNER,
          delivererId: DRIVERS[0],
        },
      });
      expect(await makeReady(O1)).toBeNull();
      const d = await delivery(O1);
      expect(d.status).toBe(DeliveryStatus.ASSIGNER);
      expect(d.delivererId).toBe(DRIVERS[0]);
      expect(d.dispatchStartedAt).toBeNull();
      expect(await prisma.outboxEvent.count()).toBe(0);
    });

    it('T25 — interrupteur éteint : aucune recherche, aucune course créée', async () => {
      await setEnabled(false);
      expect(await makeReady(O1)).toBeNull();
      expect(
        await prisma.delivery.findUnique({ where: { orderId: O1 } }),
      ).toBeNull();
      expect(
        (await prisma.order.findUniqueOrThrow({ where: { id: O1 } })).status,
      ).toBe(OrderStatus.PRET);
    });

    it('un rollback de la transition emporte la course et l’outbox', async () => {
      await prisma
        .$transaction(async (tx) => {
          await makeReadyIn(tx, O1);
          throw new Error('boom');
        })
        .catch(() => undefined);
      expect(
        await prisma.delivery.findUnique({ where: { orderId: O1 } }),
      ).toBeNull();
      expect(await prisma.outboxEvent.count()).toBe(0);
      expect(
        (await prisma.order.findUniqueOrThrow({ where: { id: O1 } })).status,
      ).toBe(OrderStatus.EN_PREPARATION);
    });
  });

  const makeReadyIn = async (tx: Prisma.TransactionClient, orderId: string) => {
    await transitions.transition(tx, {
      orderId,
      from: OrderStatus.EN_PREPARATION,
      to: OrderStatus.PRET,
      actor: 'RESTAURATEUR',
      actorUserId: OWNER,
      source: 'APP',
    });
    return dispatch.openInTransaction(tx, orderId);
  };

  // ═════════════════════════════════════════════════════════════════════════
  // Éligibilité
  // ═════════════════════════════════════════════════════════════════════════

  describe('éligibilité (T4-T8)', () => {
    it('la diffusion vise exactement les livreurs éligibles', async () => {
      const opened = await makeReady(O1);
      expect(await dispatch.runRound(opened!.deliveryId)).toBe('BROADCAST');
      expect(pushes).toHaveLength(1);
      expect(pushes[0].data?.type).toBe(PUSH_DELIVERY_OFFER);
      expect(pushes[0].data?.openDeliveryId).toBe(opened!.deliveryId);
      // ⚠️ jamais `deliveryId` : l'app installée ouvrirait la mission (403).
      expect(pushes[0].data).not.toHaveProperty('deliveryId');
      expect([...pushes[0].userIds].sort()).toEqual(
        [...DRIVERS, D_INZONE].sort(),
      );
      for (const x of EXCLUDED) expect(pushes[0].userIds).not.toContain(x);
      expect((await delivery(O1)).dispatchNotifiedCount).toBe(11);
    });

    it('la liste du livreur applique les mêmes règles, et ne montre rien du client', async () => {
      await makeReady(O1);
      await makeReady(O2);
      const list = await dispatch.listOpenForDriver(DRIVERS[0]);
      expect(list.data.map((o) => o.orderRef)).toEqual([
        `#${O1.slice(-6).toUpperCase()}`,
        `#${O2.slice(-6).toUpperCase()}`,
      ]);
      const json = JSON.stringify(list.data);
      expect(json).not.toContain('Client Secret');
      expect(json).not.toContain('+24206');
      expect(json).not.toContain('Rue secrète');
      expect(json).not.toMatch(/6750|5000|deliveryFee|driverPay/);
      expect(list.data[0].deliveryQuartier).toBe('Moungali (fcfs)');
      expect(list.data[0].restaurant.quartier).toBe('Poto-Poto (fcfs)');

      expect((await dispatch.listOpenForDriver(D_ZONE)).data).toEqual([]);
      expect((await dispatch.listOpenForDriver(D_OFF)).meta.driver.reason).toBe(
        'OFFLINE',
      );
      expect((await dispatch.listOpenForDriver(D_BAN)).meta.driver.reason).toBe(
        'ACCOUNT_BLOCKED',
      );
      expect(
        (await dispatch.listOpenForDriver(D_NOCAP)).meta.driver.reason,
      ).toBe('APP_NOT_CAPABLE');
      expect(
        (await dispatch.listOpenForDriver(D_INACT)).meta.driver.reason,
      ).toBe('PROFILE_INACTIVE');
      expect(
        (await dispatch.listOpenForDriver(D_BUSY)).meta.driver.reason,
      ).toBe('BUSY');
      // Présent mais capacité ancienne : il VOIT la liste (sa requête prouve
      // qu'il est là) ; il n'est simplement plus notifié.
      expect((await dispatch.listOpenForDriver(D_STALE)).data).toHaveLength(2);
    });

    it('le claim revérifie l’éligibilité sous transaction', async () => {
      await makeReady(O1);
      for (const [who, type, code] of [
        [D_ZONE, ForbiddenException, CLAIM_ERROR.NOT_ELIGIBLE],
        [D_BAN, ForbiddenException, CLAIM_ERROR.NOT_ELIGIBLE],
        [D_NOCAP, ForbiddenException, CLAIM_ERROR.NOT_ELIGIBLE],
        [D_INACT, ForbiddenException, CLAIM_ERROR.NOT_ELIGIBLE],
        [D_OFF, ForbiddenException, CLAIM_ERROR.NOT_ELIGIBLE],
        [D_BUSY, ConflictException, CLAIM_ERROR.DRIVER_BUSY],
      ] as const) {
        const err = await refusal(claimBy(O1, who));
        expect(err).toBeInstanceOf(type);
        expect(codeOf(err)).toBe(code);
        const d = await delivery(O1);
        expect(d.delivererId).toBeNull();
        expect(d.status).toBe(DeliveryStatus.EN_ATTENTE);
      }
      // Rien n'a fuité sur les livreurs refusés.
      expect((await driver(D_OFF)).driverStatus).toBe(DriverStatus.OFFLINE);
      expect(await prisma.deliveryAssignment.count()).toBe(0);
    });
  });

  // ═════════════════════════════════════════════════════════════════════════
  // Le claim
  // ═════════════════════════════════════════════════════════════════════════

  describe('claim (T10-T13, T17-T18)', () => {
    it('T10/T17/T18 — le premier gagne, il rejoue en 200, le second reçoit 409', async () => {
      await makeReady(O1);
      const won = await claimBy(O1, DRIVERS[0]);
      expect(won.data.status).toBe(DeliveryStatus.ACCEPTER);
      expect(JSON.stringify(won.data)).not.toMatch(/driverPay|driverShare/);

      const replay = await claimBy(O1, DRIVERS[0]);
      expect(replay.data.status).toBe(DeliveryStatus.ACCEPTER);

      const err = await refusal(claimBy(O1, DRIVERS[1]));
      expect(err).toBeInstanceOf(ConflictException);
      expect(codeOf(err)).toBe(CLAIM_ERROR.ALREADY_TAKEN);
      expect(err.message).toContain(
        'vient d’être acceptée par un autre livreur',
      );

      const d = await delivery(O1);
      expect(d.delivererId).toBe(DRIVERS[0]);
      expect(d.dispatchOutcome).toBe(DispatchOutcome.ASSIGNED);
      expect(d.dispatchEndedAt).not.toBeNull();
      expect(d.driverEconomicsFrozenAt).not.toBeNull();
      expect(d.driverPayXaf).not.toBeNull();
      // La commande reste PRET : accepter ≠ récupérer.
      expect(
        (await prisma.order.findUniqueOrThrow({ where: { id: O1 } })).status,
      ).toBe(OrderStatus.PRET);
      expect((await driver(DRIVERS[0])).driverStatus).toBe(
        DriverStatus.ON_DELIVERY,
      );
      expect((await driver(DRIVERS[1])).driverStatus).toBe(
        DriverStatus.AVAILABLE,
      );
      const log = await prisma.deliveryAssignment.findMany({
        where: { deliveryId: d.id },
      });
      expect(log).toHaveLength(1);
      expect(log[0]).toMatchObject({
        delivererId: DRIVERS[0],
        assignedByUserId: null,
        assignedByRole: 'DISPATCH',
        releasedAt: null,
      });
      expect(log[0].acceptedAt).not.toBeNull();
      // Les autres apprennent que la course est prise (données seules).
      await new Promise((r) => setTimeout(r, 50));
      const taken = pushes.find((p) => p.data?.type === 'delivery_offer_taken');
      expect(taken).toBeDefined();
      expect(taken!.userIds).not.toContain(DRIVERS[0]);
    });

    it('T11/T12 — dix claims simultanés, cinquante fois : exactement un gagnant', async () => {
      await makeReady(O1);
      const d = await delivery(O1);
      for (let i = 0; i < 50; i++) {
        await prisma.deliveryAssignment.deleteMany({});
        await prisma.delivery.update({
          where: { id: d.id },
          data: {
            delivererId: null,
            status: DeliveryStatus.EN_ATTENTE,
            dispatchEndedAt: null,
            dispatchOutcome: null,
            driverEconomicsFrozenAt: null,
            driverPayXaf: null,
          },
        });
        await prisma.user.updateMany({
          where: { id: { in: DRIVERS } },
          data: { driverStatus: DriverStatus.AVAILABLE },
        });

        const results = await Promise.allSettled(
          DRIVERS.map((who) => claims.claim(d.id, uid(who))),
        );
        const winners = results.filter((r) => r.status === 'fulfilled');
        const losers = results.filter(
          (r): r is PromiseRejectedResult => r.status === 'rejected',
        );
        expect(winners).toHaveLength(1);
        expect(losers).toHaveLength(9);
        for (const l of losers) {
          expect(l.reason).toBeInstanceOf(ConflictException);
          expect(codeOf(l.reason)).toBe(CLAIM_ERROR.ALREADY_TAKEN);
        }
        const after = await delivery(O1);
        expect(after.delivererId).not.toBeNull();
        expect(after.status).toBe(DeliveryStatus.ACCEPTER);
        const onDelivery = await prisma.user.count({
          where: {
            id: { in: DRIVERS },
            driverStatus: DriverStatus.ON_DELIVERY,
          },
        });
        expect(onDelivery).toBe(1);
        expect((await driver(after.delivererId!)).driverStatus).toBe(
          DriverStatus.ON_DELIVERY,
        );
        expect(
          await prisma.deliveryAssignment.count({
            where: { deliveryId: d.id, releasedAt: null },
          }),
        ).toBe(1);
      }
    });

    it('T13 — un livreur ne gagne pas deux courses en même temps', async () => {
      await makeReady(O1);
      await makeReady(O2);
      const [d1, d2] = await Promise.all([delivery(O1), delivery(O2)]);
      const results = await Promise.allSettled([
        claims.claim(d1.id, uid(DRIVERS[0])),
        claims.claim(d2.id, uid(DRIVERS[0])),
      ]);
      const won = results.filter((r) => r.status === 'fulfilled');
      const lost = results.filter(
        (r): r is PromiseRejectedResult => r.status === 'rejected',
      );
      expect(won).toHaveLength(1);
      expect(lost).toHaveLength(1);
      expect(codeOf(lost[0].reason)).toBe(CLAIM_ERROR.DRIVER_BUSY);
      const held = await prisma.delivery.count({
        where: { delivererId: DRIVERS[0] },
      });
      expect(held).toBe(1);
      const free = await prisma.delivery.count({
        where: {
          delivererId: null,
          status: DeliveryStatus.EN_ATTENTE,
          dispatchEndedAt: null,
        },
      });
      expect(free).toBe(1);
    });
  });

  // ═════════════════════════════════════════════════════════════════════════
  // Entrelacements forcés
  // ═════════════════════════════════════════════════════════════════════════

  describe('entrelacements (T14-T16, T19)', () => {
    it('T14/T19 — annulation tenue, claim en attente : 409 ORDER_NOT_READY et recherche close', async () => {
      await makeReady(O1);
      const d = await delivery(O1);
      const held = await holdTransaction(prisma, async (tx) => {
        await lockOrderRow(tx, O1);
        await cancel(tx, O1);
      });
      const claim = claims.claim(d.id, uid(DRIVERS[0]));
      await waitUntilBlocked(prisma);
      await held.commit();
      const err = await refusal(claim);
      expect(codeOf(err)).toBe(CLAIM_ERROR.ORDER_NOT_READY);

      const after = await delivery(O1);
      expect(after.delivererId).toBeNull();
      expect(after.dispatchOutcome).toBe(DispatchOutcome.ORDER_CLOSED);
      expect((await driver(DRIVERS[0])).driverStatus).toBe(
        DriverStatus.AVAILABLE,
      );
      expect(await dispatch.runRound(d.id)).toBe('GONE');
    });

    it('T14 bis — claim tenu, annulation en attente : la course est prise, puis la commande annulée', async () => {
      await makeReady(O1);
      const d = await delivery(O1);
      const held = await holdTransaction(prisma, async (tx) => {
        await tx.$queryRaw`SELECT status FROM "Order" WHERE id = ${O1} FOR SHARE`;
        await tx.delivery.update({
          where: { id: d.id },
          data: { delivererId: DRIVERS[0], status: DeliveryStatus.ACCEPTER },
        });
      });
      const cancelling = prisma.$transaction((tx) => cancel(tx, O1));
      await waitUntilBlocked(prisma);
      await held.commit();
      await cancelling;
      expect(
        (await prisma.order.findUniqueOrThrow({ where: { id: O1 } })).status,
      ).toBe(OrderStatus.ANNULER);
      // La recherche était encore « ouverte » côté colonnes (le claim forcé
      // n'a pas écrit l'issue) : la transition la ferme ORDER_CLOSED.
      expect((await delivery(O1)).dispatchOutcome).toBe(
        DispatchOutcome.ORDER_CLOSED,
      );
    });

    it('T15 — passage OFFLINE tenu, claim en attente : 403, rien d’écrit', async () => {
      await makeReady(O1);
      const d = await delivery(O1);
      const held = await holdTransaction(prisma, async (tx) => {
        await lockDriverRow(tx, DRIVERS[0]);
        await tx.user.update({
          where: { id: DRIVERS[0] },
          data: { driverStatus: DriverStatus.OFFLINE },
        });
      });
      const claim = claims.claim(d.id, uid(DRIVERS[0]));
      await waitUntilBlocked(prisma);
      await held.commit();
      const err = await refusal(claim);
      expect(err).toBeInstanceOf(ForbiddenException);
      expect(codeOf(err)).toBe(CLAIM_ERROR.NOT_ELIGIBLE);
      const after = await delivery(O1);
      expect(after.delivererId).toBeNull();
      expect(after.status).toBe(DeliveryStatus.EN_ATTENTE);
      expect(after.dispatchEndedAt).toBeNull();
      expect(await prisma.deliveryAssignment.count()).toBe(0);
    });

    it('T16/T24 — l’assignation historique est refusée pendant le FCFS (409, code stable)', async () => {
      await makeReady(O1);
      const d = await delivery(O1);
      for (const run of [
        () => assignment.assignDelivererToOrder(O1, DRIVERS[0], ADMIN_UID),
        () => assignment.assignDeliverer(d.id, DRIVERS[0], ADMIN_UID),
        () => assignment.assignDelivererToOrder(O1, DRIVERS[0], OWNER_UID),
      ]) {
        const err = await refusal(run());
        expect(err).toBeInstanceOf(ConflictException);
        expect(codeOf(err)).toBe(MANUAL_ASSIGNMENT_DISABLED);
      }
      // Et en concurrence avec un claim : le claim seul écrit.
      const results = await Promise.allSettled([
        claims.claim(d.id, uid(DRIVERS[1])),
        assignment.assignDeliverer(d.id, DRIVERS[0], ADMIN_UID),
      ]);
      expect(results[0].status).toBe('fulfilled');
      expect(results[1].status).toBe('rejected');
      expect((await delivery(O1)).delivererId).toBe(DRIVERS[1]);
      expect(
        await prisma.deliveryAssignment.count({ where: { releasedAt: null } }),
      ).toBe(1);
    });

    it('T25 — interrupteur éteint : l’assignation historique marche, le claim est fermé', async () => {
      await makeReady(O1); // ouverte avant extinction
      const d = await delivery(O1);
      await setEnabled(false);
      const err = await refusal(claims.claim(d.id, uid(DRIVERS[0])));
      expect(codeOf(err)).toBe(CLAIM_ERROR.DISPATCH_CLOSED);
      expect(await dispatch.runRound(d.id)).toBe('CLOSED');
      expect((await delivery(O1)).dispatchOutcome).toBe(
        DispatchOutcome.STOPPED,
      );

      const res = await assignment.assignDelivererToOrder(
        O1,
        DRIVERS[0],
        ADMIN_UID,
      );
      expect(res.data.delivererId).toBe(DRIVERS[0]);
      expect(res.data.status).toBe(DeliveryStatus.ASSIGNER);
    });

    it('une recherche ouverte au moment d’une assignation (interrupteur éteint) se clôt MANUAL_OVERRIDE', async () => {
      await makeReady(O1);
      await setEnabled(false);
      await assignment.assignDelivererToOrder(O1, DRIVERS[0], ADMIN_UID);
      expect((await delivery(O1)).dispatchOutcome).toBe(
        DispatchOutcome.MANUAL_OVERRIDE,
      );
    });
  });

  // ═════════════════════════════════════════════════════════════════════════
  // Tours, plafond, épuisement, relance
  // ═════════════════════════════════════════════════════════════════════════

  describe('tours de diffusion (T9, T20-T23)', () => {
    it('T20 — cinq tours lancés ensemble : une seule diffusion', async () => {
      const opened = await makeReady(O1);
      const results = await Promise.all(
        Array.from({ length: 5 }, () => dispatch.runRound(opened!.deliveryId)),
      );
      expect(results.filter((r) => r === 'BROADCAST')).toHaveLength(1);
      expect(pushes).toHaveLength(1);
      expect((await delivery(O1)).dispatchRound).toBe(1);
      // Pas encore dû : le cron ne renotifie pas.
      expect(await dispatch.runRound(opened!.deliveryId)).toBe('NOT_DUE');
      expect(pushes).toHaveLength(1);
    });

    it('T9/T21/T22 — cinq diffusions puis EXHAUSTED ; la commande reste PRET et le cockpit l’affiche', async () => {
      const opened = await makeReady(O1);
      const id = opened!.deliveryId;
      let now = new Date();
      for (let round = 1; round <= FCFS_MAX_ROUNDS; round++) {
        expect(await dispatch.runRound(id, now)).toBe('BROADCAST');
        expect((await delivery(O1)).dispatchRound).toBe(round);
        now = new Date(now.getTime() + FCFS_ROUND_INTERVAL_MS);
      }
      expect(pushes).toHaveLength(FCFS_MAX_ROUNDS);
      expect(await dispatch.runRound(id, now)).toBe('EXHAUSTED');
      const d = await delivery(O1);
      expect(d.dispatchOutcome).toBe(DispatchOutcome.EXHAUSTED);
      expect(d.dispatchEndReason).toBe('ROUNDS_EXHAUSTED');
      expect(d.status).toBe(DeliveryStatus.EN_ATTENTE);
      expect(d.delivererId).toBeNull();
      expect(
        (await prisma.order.findUniqueOrThrow({ where: { id: O1 } })).status,
      ).toBe(OrderStatus.PRET);
      // Plus aucun tour, plus aucun push.
      expect(await dispatch.runRound(id, now)).toBe('GONE');
      expect(pushes).toHaveLength(FCFS_MAX_ROUNDS);
      // Après épuisement, on ne peut plus l'accepter sans relance.
      expect(codeOf(await refusal(claims.claim(id, uid(DRIVERS[0]))))).toBe(
        CLAIM_ERROR.DISPATCH_CLOSED,
      );

      const buckets = await ops.queue(now);
      const exhausted = buckets.find((b) => b.key === 'dispatch_exhausted')!;
      expect(exhausted.severity).toBe('HIGH');
      expect(exhausted.items.map((i) => i.orderId)).toEqual([O1]);
      // Pas de doublon dans « sans livreur ».
      expect(
        buckets.find((b) => b.key === 'no_driver')!.items.map((i) => i.orderId),
      ).not.toContain(O1);
    });

    it('le cron ne rejoue que les tours dus, dans l’ordre', async () => {
      await makeReady(O1);
      await makeReady(O2);
      expect(await dispatch.runDueRounds()).toBe(2);
      expect(pushes).toHaveLength(2);
      expect(await dispatch.runDueRounds()).toBe(0);
      const later = new Date(Date.now() + FCFS_ROUND_INTERVAL_MS + 1000);
      expect(await dispatch.runDueRounds(later)).toBe(2);
      expect(pushes).toHaveLength(4);
      const open = await ops.queue(later);
      expect(open.find((b) => b.key === 'dispatch_open')!.count).toBe(2);
    });

    it('T23 — la relance admin rouvre une recherche épuisée sans attribuer personne', async () => {
      const opened = await makeReady(O1);
      const id = opened!.deliveryId;
      await prisma.delivery.update({
        where: { id },
        data: {
          dispatchEndedAt: new Date(),
          dispatchOutcome: DispatchOutcome.EXHAUSTED,
          dispatchEndReason: 'ROUNDS_EXHAUSTED',
          dispatchRound: 5,
        },
      });
      // Ouverte : refusée.
      await prisma.delivery.update({
        where: { id },
        data: {
          dispatchEndedAt: null,
          dispatchOutcome: null,
          dispatchEndReason: null,
        },
      });
      expect(codeOf(await refusal(dispatch.redispatch(id, ADMIN)))).toBe(
        'REDISPATCH_NOT_ALLOWED',
      );
      await prisma.delivery.update({
        where: { id },
        data: {
          dispatchEndedAt: new Date(),
          dispatchOutcome: DispatchOutcome.EXHAUSTED,
          dispatchEndReason: 'ROUNDS_EXHAUSTED',
        },
      });

      const res = await dispatch.redispatch(id, ADMIN);
      expect(res.data.state).toBe('SEARCHING');
      const d = await delivery(O1);
      expect(d.delivererId).toBeNull();
      expect(d.dispatchEndedAt).toBeNull();
      expect(d.dispatchRound).toBe(1); // premier tour parti tout de suite
      expect(pushes).toHaveLength(1);
      const ob = await prisma.outboxEvent.findMany({
        where: { type: DELIVERY_DISPATCH_REQUESTED_EVENT },
      });
      expect(ob.map((e) => (e.payload as { cause: string }).cause)).toContain(
        'ADMIN_REDISPATCH',
      );
      // Et une commande prête SANS course (prête avant l'activation) :
      await prisma.order.update({
        where: { id: O3 },
        data: { status: OrderStatus.PRET },
      });
      const r3 = await dispatch.redispatchOrder(O3, ADMIN);
      expect(r3.data.state).toBe('SEARCHING');
      expect((await delivery(O3)).dispatchRound).toBe(1);
    });

    it('un échec déclaré avant récupération (course ECHEC sans titulaire) se relance', async () => {
      const opened = await makeReady(O1);
      await prisma.delivery.update({
        where: { id: opened!.deliveryId },
        data: {
          status: DeliveryStatus.ECHEC,
          dispatchEndedAt: new Date(),
          dispatchOutcome: DispatchOutcome.STOPPED,
        },
      });
      // Une économie résiduelle (main précédente) ne doit pas survivre (D-3).
      await prisma.delivery.update({
        where: { id: opened!.deliveryId },
        data: {
          driverPayXaf: 700,
          driverBaseXaf: 1000,
          driverEconomicsFrozenAt: new Date(),
          acceptedAt: new Date(),
        },
      });
      await dispatch.redispatch(opened!.deliveryId, ADMIN);
      const d = await delivery(O1);
      expect(d.status).toBe(DeliveryStatus.EN_ATTENTE);
      expect(d.dispatchEndedAt).toBeNull();
      expect(d.driverPayXaf).toBeNull();
      expect(d.driverBaseXaf).toBeNull();
      expect(d.driverEconomicsFrozenAt).toBeNull();
      expect(d.acceptedAt).toBeNull();
    });
  });

  // ═════════════════════════════════════════════════════════════════════════
  // Désistement
  // ═════════════════════════════════════════════════════════════════════════

  describe('désistement avant récupération', () => {
    it('rend la course, libère le livreur, rouvre la recherche, trace le motif', async () => {
      await makeReady(O1);
      const won = await claimBy(O1, DRIVERS[0]);
      pushes.length = 0;
      const res = await claims.abandon(
        won.data.id as string,
        uid(DRIVERS[0]),
        'Panne de moto',
      );
      expect(res.data.status).toBe(DeliveryStatus.EN_ATTENTE);
      const d = await delivery(O1);
      expect(d.delivererId).toBeNull();
      expect(d.driverEconomicsFrozenAt).toBeNull();
      expect(d.dispatchEndedAt).toBeNull();
      expect(d.dispatchRound).toBe(1);
      expect((await driver(DRIVERS[0])).driverStatus).toBe(
        DriverStatus.AVAILABLE,
      );
      const log = await prisma.deliveryAssignment.findFirstOrThrow({
        where: { deliveryId: d.id },
      });
      expect(log.outcome).toBe(DeliveryAssignmentOutcome.DECLINED);
      expect(log.releaseReason).toContain('Panne de moto');
      // Un autre livreur peut la prendre.
      expect((await claimBy(O1, DRIVERS[1])).data.status).toBe(
        DeliveryStatus.ACCEPTER,
      );
    });

    it('est refusé après la récupération', async () => {
      await makeReady(O1);
      const won = await claimBy(O1, DRIVERS[0]);
      await prisma.delivery.update({
        where: { id: won.data.id as string },
        data: { status: DeliveryStatus.EN_TRANSIT, pickedUpAt: new Date() },
      });
      const err = await refusal(
        claims.abandon(won.data.id as string, uid(DRIVERS[0]), 'trop tard'),
      );
      expect(err).toBeInstanceOf(ConflictException);
      expect((await delivery(O1)).delivererId).toBe(DRIVERS[0]);
    });
  });
});
