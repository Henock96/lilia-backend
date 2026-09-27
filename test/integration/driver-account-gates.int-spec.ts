import { PrismaPg } from '@prisma/adapter-pg';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  DeliveryStatus,
  DriverStatus,
  OrderStatus,
  Prisma,
  PrismaClient,
  Role,
  StatusUser,
} from '@prisma/client';

import { AdminUsersService } from '../../apps/lilia-app/src/modules/admin/admin-users.service';
import { DeliveriesService } from '../../apps/lilia-app/src/modules/deliveries/deliveries.service';
import { DeliveryAssignmentLogService } from '../../apps/lilia-app/src/modules/deliveries/delivery-assignment-log.service';
import { DeliveryAssignmentService } from '../../apps/lilia-app/src/modules/deliveries/delivery-assignment.service';
import { DeliveryQueryService } from '../../apps/lilia-app/src/modules/deliveries/delivery-query.service';
import { DriversService } from '../../apps/lilia-app/src/modules/drivers/drivers.service';
import { lockDriverRow } from '../../apps/lilia-app/src/modules/drivers/driver-row-lock';
import { OrderStateMachine } from '../../apps/lilia-app/src/modules/orders/order-state.machine';
import { OrderTransitionService } from '../../apps/lilia-app/src/modules/orders/order-transition.service';
import { USER_BAN_APPLIED_EVENT } from '../../apps/lilia-app/src/modules/outbox/outbox-events';
import { PlatformSettingsService } from '../../apps/lilia-app/src/modules/platform-settings/platform-settings.service';
import { UserDeletionService } from '../../apps/lilia-app/src/modules/users/user-deletion.service';
import {
  holdTransaction,
  isDeadlock,
  waitUntilBlocked,
} from './support/lock-interleaving';

/**
 * **F3-12.1 — gates R6 (rôle) et R7 (ban) sur PostgreSQL réel.**
 *
 * R6 : jamais « rôle ≠ LIVREUR ∧ course active ». La garde « course en
 * cours » était lue HORS transaction : une assignation ou une acceptation
 * commise entre la lecture et l'écriture laissait une course à un compte
 * CLIENT, que `@Roles('LIVREUR')` empêche ensuite de faire avancer.
 *
 * R7 : un banni est immédiatement inéligible, aucune offre `OFFERED` ne lui
 * survit, il ne peut plus accepter, `activate` ne le réactive pas — et un
 * livreur banni EN PLEINE COURSE la finit (ban différé, Q3/Q7), puis est
 * banni à sa clôture.
 *
 * Méthode (lock-interleaving) : la transaction concurrente est jouée à la main
 * — mêmes verrous, mêmes écritures que le vrai geste — et TENUE ouverte ;
 * `waitUntilBlocked` fait constater par PostgreSQL que le geste testé attend
 * bien son verrou. Sans cela, un test « concurrent » peut passer sans jamais
 * avoir traversé la fenêtre dangereuse.
 *
 * Se saute proprement sans `TEST_DATABASE_URL`.
 */
const DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

jest.setTimeout(60_000);

describeIfDb('F3-12.1 R6/R7 — rôle et ban du livreur (PostgreSQL réel)', () => {
  let prisma: PrismaClient;
  let admins: AdminUsersService;
  let drivers: DriversService;
  let assignment: DeliveryAssignmentService;
  let deliveries: DeliveriesService;
  let deletion: UserDeletionService;
  const eventEmitter = new EventEmitter2();

  const OWNER = 'ag-owner';
  const ADMIN = 'ag-admin';
  const ADMIN_UID = 'fb-ag-admin';
  const CLIENT = 'ag-client';
  const A = 'ag-driver-a';
  const A_UID = 'fb-ag-a';
  const VENDOR = 'ag-vendor';
  /** Course que A porte (acceptée ou en route) dans les scénarios de ban différé. */
  const Z = 'ag-z';
  /** Seconde course : assignations concurrentes, empilement. */
  const X = 'ag-x';
  const COURSES = [Z, X];
  const order = (d: string) => `${d}-order`;

  const userCache = { invalidateOrThrow: async () => undefined };

  const reset = async () => {
    await prisma.deliveryOffer.deleteMany({});
    await prisma.incident.deleteMany({});
    await prisma.outboxEvent.deleteMany({});
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
    await prisma.user.update({
      where: { id: A },
      data: {
        firebaseUid: A_UID,
        email: 'ag-a@test.local',
        role: Role.LIVREUR,
        statusUser: StatusUser.ACTIVE,
        driverStatus: DriverStatus.AVAILABLE,
        banPendingAt: null,
        banPendingReason: null,
        banPendingById: null,
      },
    });
    await prisma.driverProfile.upsert({
      where: { userId: A },
      create: {
        userId: A,
        vehicleType: 'MOTO',
        isActive: true,
        employmentType: 'LILIA',
        compensationModel: 'PER_DELIVERY',
      },
      update: {
        isActive: true,
        deactivationReason: null,
        offersEnabledAt: new Date(),
      },
    });
  };

  /** La course porte A au statut donné, avec sa main ouverte au journal. */
  const give = async (delivery: string, status: DeliveryStatus) => {
    await prisma.delivery.update({
      where: { id: delivery },
      data: { delivererId: A, status },
    });
    await prisma.deliveryAssignment.create({
      data: {
        deliveryId: delivery,
        orderId: order(delivery),
        delivererId: A,
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
        where: { id: A },
        data: { driverStatus: DriverStatus.ON_DELIVERY },
      });
    }
  };

  /** Offre ouverte à A sur la course donnée (dispatch allumé en montage). */
  const openOffer = (
    delivery: string,
    db: PrismaClient | Prisma.TransactionClient = prisma,
  ) =>
    db.$executeRaw`
      INSERT INTO "DeliveryOffer"
        (id, "deliveryId", "driverId", round, "poolSize", "employmentType",
         "compensationModel", "baseXaf", "sharePercent", "payXaf", "expiresAt")
      VALUES (${`offer-${delivery}`}, ${delivery}, ${A}, 1, 1, 'LILIA',
              'PER_DELIVERY', 1000, 35, 350, now() + interval '90 seconds')
    `;

  const openOffersOfA = () =>
    prisma.deliveryOffer.count({ where: { driverId: A, status: 'OFFERED' } });

  const userA = () => prisma.user.findUniqueOrThrow({ where: { id: A } });

  const activeCoursesOfA = () =>
    prisma.delivery.count({
      where: {
        delivererId: A,
        status: {
          in: [
            DeliveryStatus.ASSIGNER,
            DeliveryStatus.ACCEPTER,
            DeliveryStatus.EN_TRANSIT,
          ],
        },
      },
    });

  /** R6 : jamais un compte non-LIVREUR titulaire d'une course active. */
  const expectR6 = async () => {
    const [u, active] = await Promise.all([userA(), activeCoursesOfA()]);
    if (u.role !== Role.LIVREUR) expect(active).toBe(0);
  };

  /** Rejet métier (409/403/400/404), jamais un interblocage. */
  const expectBusinessRefusal = async (
    run: Promise<unknown>,
    type:
      | typeof BadRequestException
      | typeof ConflictException
      | typeof ForbiddenException,
  ) => {
    const err = await run.then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).not.toBeNull();
    expect(isDeadlock(err)).toBe(false);
    expect(err).toBeInstanceOf(type);
  };

  // ─── Gestes concurrents joués à la main, verrous tenus ───────────────────

  /** `_doAssign` : R4 du livreur, puis la course lui est confiée. */
  const heldAssign = (delivery: string) =>
    holdTransaction(prisma, async (tx) => {
      await lockDriverRow(tx, A);
      await tx.delivery.update({
        where: { id: delivery },
        data: { delivererId: A, status: DeliveryStatus.ASSIGNER },
      });
    });

  /** `acceptDelivery` : la course passe ACCEPTER, A passe ON_DELIVERY (R4). */
  const heldAccept = (delivery: string) =>
    holdTransaction(prisma, async (tx) => {
      await tx.delivery.update({
        where: { id: delivery },
        data: { status: DeliveryStatus.ACCEPTER, acceptedAt: new Date() },
      });
      await tx.user.update({
        where: { id: A },
        data: { driverStatus: DriverStatus.ON_DELIVERY },
      });
    });

  /** Un autre écrivain du compte sous R4 (rôle, statut). */
  const heldAccountWrite = (data: Prisma.UserUpdateInput) =>
    holdTransaction(prisma, async (tx) => {
      await lockDriverRow(tx, A);
      await tx.user.update({ where: { id: A }, data });
    });

  // ─── Montage ─────────────────────────────────────────────────────────────

  beforeAll(async () => {
    prisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: DATABASE_URL }),
    });
    await prisma.$connect();

    const assignmentLog = new DeliveryAssignmentLogService();
    const stateMachine = new OrderStateMachine();
    const transitions = new OrderTransitionService();
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
    drivers = new DriversService(
      prisma as never,
      {} as never,
      { record: async () => undefined } as never,
      {} as never,
      {} as never,
    );
    admins = new AdminUsersService(prisma as never, userCache as never);
    deletion = new UserDeletionService(
      prisma as never,
      { deleteUserSafe: async () => undefined } as never,
      userCache as never,
    );

    await prisma.$executeRawUnsafe(`
      TRUNCATE TABLE "DeliveryOffer", "Incident", "OutboxEvent",
                     "DeliveryFailureReport", "DeliveryAssignment",
                     "DeliveryHandover", "DeliveryReview", "DeliveryLocation",
                     "Delivery", "OrderItem", "OrderHistory", "Order",
                     "DriverProfile", "Restaurant", "PlatformSettings", "User"
      RESTART IDENTITY CASCADE
    `);
    // Offres autorisées : les tests de révocation en ouvrent.
    await prisma.platformSettings.create({
      data: { id: 'singleton', dispatchEnabled: true },
    });
    await prisma.user.createMany({
      data: [
        { id: CLIENT, firebaseUid: 'fb-ag-c', email: 'ag-c@test.local' },
        {
          id: OWNER,
          firebaseUid: 'fb-ag-o',
          email: 'ag-o@test.local',
          role: 'RESTAURATEUR',
        },
        {
          id: ADMIN,
          firebaseUid: ADMIN_UID,
          email: 'ag-adm@test.local',
          role: 'ADMIN',
        },
        {
          id: A,
          firebaseUid: A_UID,
          email: 'ag-a@test.local',
          nom: 'Livreur A',
          role: 'LIVREUR',
          driverStatus: 'AVAILABLE',
        },
      ],
    });
    await prisma.restaurant.create({
      data: {
        id: VENDOR,
        nom: 'Chez Garde',
        adresse: 'Bacongo',
        phone: '060000013',
        ownerId: OWNER,
      },
    });
    await prisma.order.createMany({
      data: COURSES.map((d) => ({
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
      data: COURSES.map((d) => ({
        id: d,
        orderId: order(d),
        status: DeliveryStatus.EN_ATTENTE,
      })),
    });
  });

  afterAll(async () => {
    // Les autres suites suppriment des `User` : une offre restante (FK
    // RESTRICT) les ferait échouer, et l'interrupteur allumé les tromperait.
    await prisma.deliveryOffer.deleteMany({});
    await prisma.platformSettings.updateMany({
      data: { dispatchEnabled: false },
    });
    await prisma.$disconnect();
  });

  beforeEach(reset);

  // ═════════════════════════════════════════════════════════════════════════
  // R6 — changement de rôle
  // ═════════════════════════════════════════════════════════════════════════

  describe('R6 — changement de rôle', () => {
    it.each([
      DeliveryStatus.ASSIGNER,
      DeliveryStatus.ACCEPTER,
      DeliveryStatus.EN_TRANSIT,
    ])('course %s → 409, rien écrit', async (status) => {
      await give(Z, status);
      await expectBusinessRefusal(
        admins.updateUserRole(A, { role: Role.CLIENT } as never),
        ConflictException,
      );
      const u = await userA();
      expect(u.role).toBe(Role.LIVREUR);
      const profile = await prisma.driverProfile.findUniqueOrThrow({
        where: { userId: A },
      });
      expect(profile.isActive).toBe(true);
    });

    it('sans course : rôle écrit, disponibilité effacée, profil hors service, offre retirée', async () => {
      await openOffer(Z);
      await admins.updateUserRole(A, { role: Role.CLIENT } as never);
      const u = await userA();
      expect(u).toMatchObject({ role: Role.CLIENT, driverStatus: null });
      const profile = await prisma.driverProfile.findUniqueOrThrow({
        where: { userId: A },
      });
      expect(profile.isActive).toBe(false);
      expect(await openOffersOfA()).toBe(0);
    });

    it('rôle → LIVREUR refusé (Q4 : création par la fiche Livreurs)', async () => {
      await expectBusinessRefusal(
        admins.updateUserRole(CLIENT, { role: Role.LIVREUR } as never),
        ConflictException,
      );
    });

    /**
     * Mutations tuées : garde replacée hors transaction ; `lockDriverRow`
     * retiré (la garde lit avant que l'`UPDATE` du compte n'attende).
     */
    it('assignation ∥ rôle (assignation d’abord) : 409, jamais un CLIENT titulaire', async () => {
      const held = await heldAssign(X);
      const role = admins.updateUserRole(A, { role: Role.CLIENT } as never);
      await waitUntilBlocked(prisma);
      await held.commit();
      await expectBusinessRefusal(role, ConflictException);
      expect((await userA()).role).toBe(Role.LIVREUR);
      await expectR6();
    });

    it('assignation ∥ rôle (rôle d’abord) : l’assignation est refusée', async () => {
      const held = await heldAccountWrite({
        role: Role.CLIENT,
        driverStatus: null,
      });
      const assign = assignment.assignDeliverer(X, A, ADMIN_UID);
      await waitUntilBlocked(prisma);
      await held.commit();
      await expectBusinessRefusal(assign, ForbiddenException);
      await expectR6();
    });

    it('acceptation ∥ rôle (rôle d’abord) : l’acceptation est refusée', async () => {
      await give(X, DeliveryStatus.ASSIGNER);
      const held = await heldAccountWrite({
        role: Role.CLIENT,
        driverStatus: null,
      });
      const accept = assignment.acceptDelivery(X, A_UID);
      await waitUntilBlocked(prisma);
      await held.commit();
      await expectBusinessRefusal(accept, ForbiddenException);
      const x = await prisma.delivery.findUniqueOrThrow({ where: { id: X } });
      expect(x.status).toBe(DeliveryStatus.ASSIGNER);
    });

    /** Mutation tuée : CAS `role = 'LIVREUR'` retiré (écriture aveugle). */
    it('rôle ∥ rôle : le second, périmé, est refusé au lieu d’écraser le premier', async () => {
      const held = await heldAccountWrite({ role: Role.RESTAURATEUR });
      const second = admins.updateUserRole(A, { role: Role.CLIENT } as never);
      await waitUntilBlocked(prisma);
      await held.commit();
      await expectBusinessRefusal(second, ConflictException);
      expect((await userA()).role).toBe(Role.RESTAURATEUR);
    });

    /** §13, même classe de défaut : la garde de suppression lue hors tx. */
    it('assignation ∥ suppression de compte : 409, le compte n’est pas anonymisé', async () => {
      const held = await heldAssign(X);
      const del = deletion.deleteOwnAccount(A);
      await waitUntilBlocked(prisma);
      await held.commit();
      await expectBusinessRefusal(del, ConflictException);
      expect((await userA()).statusUser).toBe(StatusUser.ACTIVE);
    });

    it('suppression d’un livreur libre : ses offres ouvertes tombent', async () => {
      await openOffer(Z);
      await deletion.deleteOwnAccount(A);
      expect(await openOffersOfA()).toBe(0);
    });
  });

  // ═════════════════════════════════════════════════════════════════════════
  // R7 — ban
  // ═════════════════════════════════════════════════════════════════════════

  describe('R7 — ban immédiat', () => {
    it('livreur libre : BLOCKED + OFFLINE, offre retirée, plus assignable', async () => {
      await openOffer(Z);
      const res = await admins.banUser(A, 'fraude', ADMIN);
      expect(res.mode).toBe('immediate');
      expect(await userA()).toMatchObject({
        statusUser: StatusUser.BLOCKED,
        driverStatus: DriverStatus.OFFLINE,
        banPendingAt: null,
      });
      expect(await openOffersOfA()).toBe(0);
      await expectBusinessRefusal(
        assignment.assignDeliverer(X, A, ADMIN_UID),
        ForbiddenException,
      );
    });

    it('une course seulement ASSIGNER ne retient pas le ban, et reste à réassigner', async () => {
      await give(X, DeliveryStatus.ASSIGNER);
      const res = await admins.banUser(A, undefined, ADMIN);
      expect(res).toMatchObject({ mode: 'immediate', waitingAssignments: 1 });
      // Banni, donc OFFLINE : le pré-contrôle de disponibilité refuse déjà.
      await expectBusinessRefusal(
        assignment.acceptDelivery(X, A_UID),
        BadRequestException,
      );
      const x = await prisma.delivery.findUniqueOrThrow({ where: { id: X } });
      expect(x.status).toBe(DeliveryStatus.ASSIGNER);
    });

    it('ban ∥ assignation (ban d’abord) : l’assignation est refusée', async () => {
      const held = await heldAccountWrite({
        statusUser: StatusUser.BLOCKED,
        driverStatus: DriverStatus.OFFLINE,
      });
      const assign = assignment.assignDeliverer(X, A, ADMIN_UID);
      await waitUntilBlocked(prisma);
      await held.commit();
      await expectBusinessRefusal(assign, ForbiddenException);
    });

    /**
     * Mutation tuée : CAS d'acceptation sans `statusUser`. L'écrivain
     * concurrent ne touche QUE le compte — la disponibilité reste AVAILABLE,
     * seul `statusUser` peut donc refuser.
     */
    it('ban ∥ acceptation (ban d’abord) : 403, la course reste ASSIGNER', async () => {
      await give(X, DeliveryStatus.ASSIGNER);
      const held = await heldAccountWrite({ statusUser: StatusUser.BLOCKED });
      const accept = assignment.acceptDelivery(X, A_UID);
      await waitUntilBlocked(prisma);
      await held.commit();
      await expectBusinessRefusal(accept, ForbiddenException);
      const x = await prisma.delivery.findUniqueOrThrow({ where: { id: X } });
      expect(x.status).toBe(DeliveryStatus.ASSIGNER);
    });

    /** Mutation tuée : `activate` sans R4 (statut lu hors verrou). */
    it('ban ∥ activate (ban d’abord) : le profil d’un banni n’est jamais remis en service', async () => {
      await prisma.driverProfile.update({
        where: { userId: A },
        data: { isActive: false },
      });
      const held = await heldAccountWrite({ statusUser: StatusUser.BLOCKED });
      const activate = drivers.activate(A, ADMIN);
      await waitUntilBlocked(prisma);
      await held.commit();
      await expectBusinessRefusal(activate, ConflictException);
      const profile = await prisma.driverProfile.findUniqueOrThrow({
        where: { userId: A },
      });
      expect(profile.isActive).toBe(false);
    });

    /**
     * §8.4, cas B : une recherche insère une offre, puis vérifie le livreur
     * sous R4 FOR SHARE — pas encore commise quand le ban retire les offres.
     * Mutation tuée : balayage post-commit (tx2) retiré.
     */
    it('ban ∥ création d’offre : aucune offre OFFERED ne survit au ban', async () => {
      const held = await holdTransaction(prisma, async (tx) => {
        await openOffer(Z, tx);
        await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${A} FOR SHARE`;
      });
      const ban = admins.banUser(A, undefined, ADMIN);
      await waitUntilBlocked(prisma);
      await held.commit();
      await ban;
      expect(await openOffersOfA()).toBe(0);
      const offer = await prisma.deliveryOffer.findUniqueOrThrow({
        where: { id: `offer-${Z}` },
      });
      expect(offer.status).toBe('CANCELLED');
    });

    /**
     * tx1 retire les offres AVANT d'écrire le ban, dans la même transaction :
     * aucun lecteur ne voit jamais « banni ∧ offre ouverte ». Sans R3, le ban
     * commit d'abord et le balayage tx2 n'arrive qu'après — fenêtre pendant
     * laquelle une offre ouverte appartient à un banni.
     * Mutation tuée : ban sans R3 (le balayage seul rattrape l'offre, trop tard).
     */
    it('ban atomique : jamais « BLOCKED ∧ offre OFFERED » visible, même un instant', async () => {
      await openOffer(Z);
      // Une acceptation d'offre en cours tient la ligne de l'offre (R3).
      const held = await holdTransaction(prisma, async (tx) => {
        await tx.$queryRaw`SELECT id FROM "DeliveryOffer" WHERE id = ${`offer-${Z}`} FOR UPDATE`;
      });
      const ban = admins.banUser(A, undefined, ADMIN);
      await waitUntilBlocked(prisma);
      const [u, open] = await Promise.all([userA(), openOffersOfA()]);
      expect({
        blocked: u.statusUser === StatusUser.BLOCKED,
        open,
      }).not.toEqual({
        blocked: true,
        open: 1,
      });
      await held.rollback();
      await ban;
      expect(await openOffersOfA()).toBe(0);
    });

    it('débanni : ACTIVE mais OFFLINE et sans capacité d’offres — il doit se redéclarer', async () => {
      await admins.banUser(A, undefined, ADMIN);
      const res = await admins.unbanUser(A);
      expect(res.wasBlocked).toBe(true);
      expect(await userA()).toMatchObject({
        statusUser: StatusUser.ACTIVE,
        driverStatus: DriverStatus.OFFLINE,
      });
      const profile = await prisma.driverProfile.findUniqueOrThrow({
        where: { userId: A },
      });
      expect(profile.offersEnabledAt).toBeNull();
    });
  });

  describe('R7 — ban différé d’un livreur en pleine course (Q3/Q7)', () => {
    it.each([DeliveryStatus.ACCEPTER, DeliveryStatus.EN_TRANSIT])(
      'course %s : compte laissé ACTIVE, drapeau posé, incident ouvert, offre retirée',
      async (status) => {
        await give(Z, status);
        await openOffer(X);
        const res = await admins.banUser(A, 'fraude', ADMIN);
        expect(res.mode).toBe('deferred');
        const u = await userA();
        expect(u.statusUser).toBe(StatusUser.ACTIVE);
        expect(u.driverStatus).toBe(DriverStatus.ON_DELIVERY);
        expect(u.banPendingAt).toBeInstanceOf(Date);
        expect(u.banPendingById).toBe(ADMIN);
        expect(await openOffersOfA()).toBe(0);
        const incident = await prisma.incident.findFirstOrThrow({
          where: { dedupKey: `ban_pending:${A}` },
        });
        expect(incident).toMatchObject({ status: 'OPEN', orderId: order(Z) });
      },
    );

    it('inéligible tout de suite : ni assignation, ni acceptation d’une course empilée', async () => {
      await give(Z, DeliveryStatus.ACCEPTER);
      await give(X, DeliveryStatus.ASSIGNER);
      await admins.banUser(A, undefined, ADMIN);
      // ON_DELIVERY (il porte Z) : refusé dès le pré-contrôle. Le CAS
      // `banPendingAt: null` est la ceinture si ce pré-contrôle disparaît.
      await expectBusinessRefusal(
        assignment.acceptDelivery(X, A_UID),
        BadRequestException,
      );
      await prisma.deliveryAssignment.updateMany({
        where: { deliveryId: X, releasedAt: null },
        data: { releasedAt: new Date(), outcome: 'REASSIGNED' },
      });
      await prisma.delivery.update({
        where: { id: X },
        data: { delivererId: null, status: DeliveryStatus.EN_ATTENTE },
      });
      await expectBusinessRefusal(
        assignment.assignDeliverer(X, A, ADMIN_UID),
        ForbiddenException,
      );
    });

    it('il finit sa course : à LIVRER, banni (BLOCKED, OFFLINE), coupure Firebase due, incident résolu', async () => {
      await give(Z, DeliveryStatus.EN_TRANSIT);
      await admins.banUser(A, 'fraude', ADMIN);
      await deliveries.updateStatus(
        Z,
        DeliveryStatus.LIVRER as never,
        ADMIN_UID,
      );

      expect(await userA()).toMatchObject({
        statusUser: StatusUser.BLOCKED,
        driverStatus: DriverStatus.OFFLINE,
        banPendingAt: null,
        banPendingReason: null,
        banPendingById: null,
      });
      const due = await prisma.outboxEvent.findMany({
        where: { type: USER_BAN_APPLIED_EVENT, aggregateId: A },
      });
      expect(due).toHaveLength(1);
      const incident = await prisma.incident.findFirstOrThrow({
        where: { dedupKey: `ban_pending:${A}` },
      });
      expect(incident).toMatchObject({
        status: 'RESOLVED',
        autoResolved: true,
      });
    });

    it('course réassignée : le ban s’applique aussi à cette clôture', async () => {
      await give(Z, DeliveryStatus.ACCEPTER);
      await admins.banUser(A, undefined, ADMIN);
      // B n'existe pas : on détache par la voie de l'échec déclaré (L2).
      await deliveries.updateStatus(
        Z,
        DeliveryStatus.ECHEC as never,
        ADMIN_UID,
        'livreur banni',
      );
      expect((await userA()).statusUser).toBe(StatusUser.BLOCKED);
    });

    it('ban ∥ acceptation (acceptation d’abord) : le ban devient différé', async () => {
      await give(X, DeliveryStatus.ASSIGNER);
      const held = await heldAccept(X);
      const ban = admins.banUser(A, undefined, ADMIN);
      await waitUntilBlocked(prisma);
      await held.commit();
      const res = await ban;
      expect(res.mode).toBe('deferred');
      const u = await userA();
      expect(u.statusUser).toBe(StatusUser.ACTIVE);
      expect(u.banPendingAt).toBeInstanceOf(Date);
    });

    it('second ban programmé → 409', async () => {
      await give(Z, DeliveryStatus.ACCEPTER);
      await admins.banUser(A, undefined, ADMIN);
      await expectBusinessRefusal(
        admins.banUser(A, undefined, ADMIN),
        ConflictException,
      );
    });

    it('ban programmé annulé : drapeau effacé, incident résolu, la course va à son terme', async () => {
      await give(Z, DeliveryStatus.EN_TRANSIT);
      await admins.banUser(A, undefined, ADMIN);
      const res = await admins.unbanUser(A);
      expect(res.wasBlocked).toBe(false);
      await deliveries.updateStatus(
        Z,
        DeliveryStatus.LIVRER as never,
        ADMIN_UID,
      );
      expect(await userA()).toMatchObject({
        statusUser: StatusUser.ACTIVE,
        driverStatus: DriverStatus.AVAILABLE,
        banPendingAt: null,
      });
      expect(
        await prisma.outboxEvent.count({
          where: { type: USER_BAN_APPLIED_EVENT },
        }),
      ).toBe(0);
    });

    it('la base refuse un ban en attente sur un compte non ACTIVE', async () => {
      await expect(
        prisma.user.update({
          where: { id: A },
          data: { statusUser: StatusUser.BLOCKED, banPendingAt: new Date() },
        }),
      ).rejects.toThrow(/User_ban_pending_consistent/);
    });
  });
});
