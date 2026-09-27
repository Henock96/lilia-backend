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

import { DeliveriesService } from '../../apps/lilia-app/src/modules/deliveries/deliveries.service';
import { DeliveryAssignmentLogService } from '../../apps/lilia-app/src/modules/deliveries/delivery-assignment-log.service';
import { DeliveryAssignmentService } from '../../apps/lilia-app/src/modules/deliveries/delivery-assignment.service';
import { DeliveryQueryService } from '../../apps/lilia-app/src/modules/deliveries/delivery-query.service';
import { DriversService } from '../../apps/lilia-app/src/modules/drivers/drivers.service';
import { OrderStateMachine } from '../../apps/lilia-app/src/modules/orders/order-state.machine';
import { OrderTransitionService } from '../../apps/lilia-app/src/modules/orders/order-transition.service';
import { PlatformSettingsService } from '../../apps/lilia-app/src/modules/platform-settings/platform-settings.service';
import { UserDeletionService } from '../../apps/lilia-app/src/modules/users/user-deletion.service';
import {
  holdTransaction,
  isDeadlock,
  openTransaction,
  rejections,
  waitUntilBlocked,
} from './support/lock-interleaving';

/**
 * **F3-12.0 — prérequis de concurrence du dispatch, contre un vrai PostgreSQL.**
 *
 * Chaque course du lot est éprouvée de deux façons :
 *
 *  1. **entrelacement forcé** — la transaction A tient ses verrous, on
 *     vérifie dans `pg_stat_activity` que B l'attend réellement, puis A
 *     commit. C'est la preuve que le scénario dangereux est couvert : sans le
 *     correctif, ces tests ÉCHOUENT (vérifié en retirant chaque correctif) ;
 *  2. **répétition** — `REPS` fois (50 par défaut) les deux gestes lancés en
 *     parallèle, sur des connexions distinctes, avec les invariants vérifiés
 *     à chaque tour et 0 interblocage (40P01) toléré.
 *
 * ⚠️ L'acceptation d'une OFFRE (F3-12.4) n'existe pas encore. Or c'est elle
 * qui rend les courses A et B atteignables : aujourd'hui, un livreur ne peut
 * accepter qu'une mission `ASSIGNER`, et `setDriverStatus` / `deactivate`
 * refusent déjà tout livreur qui en a une. `acceptLikeOffer` rejoue donc
 * l'écriture que fera l'acceptation d'offre, dans l'ordre global des verrous
 * du Hardening (§5.1) : `Order FOR SHARE → Delivery → User`. C'est la forme
 * contre laquelle les correctifs de ce lot doivent tenir.
 *
 * Se saute proprement sans `TEST_DATABASE_URL`.
 */
const DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;
const REPS = Number(process.env.F312_REPS ?? 50);

// Les boucles ×REPS enchaînent jusqu'à 5 transactions par tour : ~1-2 s à
// vide, mais 25-30 s sous charge CPU saturée (gate finale du 27/09/2026),
// soit le `testTimeout` global. Un interblocage, lui, ne se cache pas
// derrière ce délai : PostgreSQL le tranche en ~1 s (40P01), que
// `expectOnlyBusinessRefusals` refuse.
jest.setTimeout(120_000);

describeIfDb('F3-12.0 — concurrence livreur / course (PostgreSQL réel)', () => {
  let prisma: PrismaClient;
  let assignment: DeliveryAssignmentService;
  let deliveries: DeliveriesService;
  let drivers: DriversService;
  const transitions = new OrderTransitionService();

  const OWNER = 'f120-owner';
  const OWNER_UID = 'fb-f120-owner';
  const ADMIN = 'f120-admin';
  const ADMIN_UID = 'fb-f120-admin';
  const CLIENT = 'f120-client';
  const A = 'f120-driver-a';
  const A_UID = 'fb-f120-a';
  const B = 'f120-driver-b';
  const VENDOR = 'f120-vendor';
  const ORDER = 'f120-order';
  const DELIVERY = 'f120-delivery';
  /** Commande SANS livraison : exerce la création atomique (B5). */
  const ORDER_BARE = 'f120-order-bare';

  // ─── État ────────────────────────────────────────────────────────────────

  const reset = async () => {
    await prisma.deliveryAssignment.deleteMany({});
    await prisma.deliveryHandover.deleteMany({});
    await prisma.orderHistory.deleteMany({});
    await prisma.delivery.deleteMany({ where: { orderId: ORDER_BARE } });
    await prisma.delivery.update({
      where: { id: DELIVERY },
      data: {
        delivererId: null,
        status: DeliveryStatus.EN_ATTENTE,
        acceptedAt: null,
        pickedUpAt: null,
        deliveredAt: null,
        driverBaseXaf: null,
        driverEmploymentType: null,
        driverCompensationModel: null,
        driverSharePercent: null,
        driverPayXaf: null,
        driverEconomicsFrozenAt: null,
      },
    });
    // Les colonnes F3-07 d'une commande passée par `LIVRER` sont remises à
    // zéro AVEC le statut : les CHECK de preuve de livraison l'exigent.
    await prisma.order.updateMany({
      where: { id: { in: [ORDER, ORDER_BARE] } },
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

  const snapshot = async () => {
    const [delivery, a, profileA, open] = await Promise.all([
      prisma.delivery.findUniqueOrThrow({ where: { id: DELIVERY } }),
      prisma.user.findUniqueOrThrow({ where: { id: A } }),
      prisma.driverProfile.findUniqueOrThrow({ where: { userId: A } }),
      prisma.deliveryAssignment.findMany({
        where: { deliveryId: DELIVERY, releasedAt: null },
      }),
    ]);
    return { delivery, a, profileA, open };
  };

  /**
   * Forme de l'acceptation d'offre à venir (F3-12.4, `freezeAndAccept`) :
   * R1 `Order FOR SHARE`, R2 CAS `Delivery EN_ATTENTE → ACCEPTER`, R4 CAS
   * `User AVAILABLE → ON_DELIVERY` (compte ACTIF, rôle LIVREUR), R5 profil.
   */
  const acceptLikeOffer = async (
    tx: Prisma.TransactionClient,
    driverId: string,
  ) => {
    const [order] = await tx.$queryRaw<{ status: OrderStatus }[]>`
      SELECT status FROM "Order" WHERE id = ${ORDER} FOR SHARE`;
    if (order.status === OrderStatus.ANNULER) {
      throw new ConflictException('ORDER_CLOSED');
    }
    const claimed = await tx.delivery.updateMany({
      where: {
        id: DELIVERY,
        status: DeliveryStatus.EN_ATTENTE,
        delivererId: null,
      },
      data: {
        status: DeliveryStatus.ACCEPTER,
        delivererId: driverId,
        acceptedAt: new Date(),
      },
    });
    if (claimed.count === 0) throw new ConflictException('DELIVERY_TAKEN');
    const driver = await tx.user.updateMany({
      where: {
        id: driverId,
        driverStatus: DriverStatus.AVAILABLE,
        statusUser: StatusUser.ACTIVE,
        role: Role.LIVREUR,
      },
      data: { driverStatus: DriverStatus.ON_DELIVERY },
    });
    if (driver.count === 0) {
      throw new ConflictException('DRIVER_NOT_AVAILABLE');
    }
    const profile = await tx.driverProfile.findUnique({
      where: { userId: driverId },
      select: { isActive: true },
    });
    if (!profile?.isActive) throw new ConflictException('DRIVER_INACTIVE');
  };

  const acceptLikeOfferTx = (driverId: string) =>
    prisma.$transaction((tx) => acceptLikeOffer(tx, driverId));

  /** Annulation de commande : le même `UPDATE` conditionnel que le vrai chemin. */
  const cancelOrder = (tx: Prisma.TransactionClient, orderId = ORDER) =>
    transitions.transition(tx, {
      orderId,
      from: OrderStatus.PRET,
      to: OrderStatus.ANNULER,
      actor: 'ADMIN',
      actorUserId: ADMIN,
      source: 'ADMIN_APP',
    });

  /** Aucun interblocage, et seulement des refus métier attendus. */
  const expectOnlyBusinessRefusals = (
    results: PromiseSettledResult<unknown>[],
  ) => {
    for (const err of rejections(results)) {
      expect(isDeadlock(err)).toBe(false);
      expect(
        err instanceof ConflictException ||
          err instanceof BadRequestException ||
          err instanceof ForbiddenException,
      ).toBe(true);
    }
  };

  // ─── Montage ─────────────────────────────────────────────────────────────

  beforeAll(async () => {
    prisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: DATABASE_URL }),
    });
    await prisma.$connect();

    const eventEmitter = new EventEmitter2();
    const assignmentLog = new DeliveryAssignmentLogService();
    const stateMachine = new OrderStateMachine();
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
      {} as never, // notifications : non exercées
      eventEmitter,
      stateMachine,
      transitions,
      {} as never, // gateway : non exercée
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
      {} as never, // firebase : non exercé par deactivate
      { record: async () => undefined } as never,
      {} as never, // cache : non exercé par deactivate
      {} as never, // pagination : non exercée par deactivate
    );

    await prisma.$executeRawUnsafe(`
      TRUNCATE TABLE "DeliveryAssignment", "DeliveryHandover", "DeliveryReview",
                     "DeliveryLocation", "Delivery", "OrderItem", "OrderHistory",
                     "Order", "DriverProfile", "Restaurant", "User"
      RESTART IDENTITY CASCADE
    `);

    await prisma.user.createMany({
      data: [
        { id: CLIENT, firebaseUid: 'fb-f120-c', email: 'f120-c@test.local' },
        {
          id: OWNER,
          firebaseUid: OWNER_UID,
          email: 'f120-o@test.local',
          role: 'RESTAURATEUR',
        },
        {
          id: ADMIN,
          firebaseUid: ADMIN_UID,
          email: 'f120-adm@test.local',
          role: 'ADMIN',
        },
        {
          id: A,
          firebaseUid: A_UID,
          email: 'f120-a@test.local',
          nom: 'Livreur A',
          role: 'LIVREUR',
          driverStatus: 'AVAILABLE',
        },
        {
          id: B,
          firebaseUid: 'fb-f120-b',
          email: 'f120-b@test.local',
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
        nom: 'Chez F3-12.0',
        adresse: 'Poto-Poto',
        phone: '060000120',
        ownerId: OWNER,
      },
    });
    const order = {
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
    };
    await prisma.order.createMany({
      data: [
        { id: ORDER, ...order },
        { id: ORDER_BARE, ...order },
      ],
    });
    await prisma.delivery.create({
      data: { id: DELIVERY, orderId: ORDER, status: DeliveryStatus.EN_ATTENTE },
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(reset);

  // ═════════════════════════════════════════════════════════════════════════
  // Test A — ACCEPT ∥ setDriverStatus (B1)
  // ═════════════════════════════════════════════════════════════════════════

  describe('A — acceptation ∥ disponibilité (setDriverStatus)', () => {
    it('entrelacement forcé : AVAILABLE attend l’acceptation, puis voit la course et refuse', async () => {
      const held = await holdTransaction(prisma, (tx) =>
        acceptLikeOffer(tx, A),
      );

      const toggle = deliveries.setDriverStatus(A_UID, DriverStatus.AVAILABLE);
      toggle.catch(() => undefined);
      // Avant F3-12.0 : la garde lisait « aucune course » HORS transaction
      // (l'acceptation n'est pas commise), puis l'UPDATE attendait la ligne
      // User et écrasait ON_DELIVERY par AVAILABLE au commit.
      await waitUntilBlocked(prisma);
      await held.commit();

      await expect(toggle).rejects.toBeInstanceOf(BadRequestException);
      const { delivery, a } = await snapshot();
      expect(delivery.status).toBe(DeliveryStatus.ACCEPTER);
      expect(a.driverStatus).toBe(DriverStatus.ON_DELIVERY);
    });

    it('entrelacement forcé : OFFLINE attend l’acceptation, puis refuse', async () => {
      const held = await holdTransaction(prisma, (tx) =>
        acceptLikeOffer(tx, A),
      );
      const toggle = deliveries.setDriverStatus(A_UID, DriverStatus.OFFLINE);
      toggle.catch(() => undefined);
      await waitUntilBlocked(prisma);
      await held.commit();

      await expect(toggle).rejects.toBeInstanceOf(BadRequestException);
      expect((await snapshot()).a.driverStatus).toBe(DriverStatus.ON_DELIVERY);
    });

    it.each([DriverStatus.AVAILABLE, DriverStatus.OFFLINE])(
      `×${REPS} en parallèle (%s) : jamais « course acceptée » sans ON_DELIVERY, 0 interblocage`,
      async (target) => {
        for (let i = 0; i < REPS; i++) {
          await reset();
          const results = await Promise.allSettled([
            acceptLikeOfferTx(A),
            deliveries.setDriverStatus(A_UID, target),
          ]);
          expectOnlyBusinessRefusals(results);

          const { delivery, a } = await snapshot();
          // I10 : course ACCEPTER ⇔ livreur ON_DELIVERY.
          expect(delivery.status === DeliveryStatus.ACCEPTER).toBe(
            a.driverStatus === DriverStatus.ON_DELIVERY,
          );
        }
      },
    );

    it('ON_DELIVERY sans course reste réparable par le livreur (libération best-effort perdue)', async () => {
      await prisma.user.update({
        where: { id: A },
        data: { driverStatus: DriverStatus.ON_DELIVERY },
      });
      const out = await deliveries.setDriverStatus(
        A_UID,
        DriverStatus.AVAILABLE,
      );
      expect(out.driverStatus).toBe(DriverStatus.AVAILABLE);
    });
  });

  // ═════════════════════════════════════════════════════════════════════════
  // Test B — ACCEPT ∥ deactivate (B2)
  // ═════════════════════════════════════════════════════════════════════════

  describe('B — acceptation ∥ désactivation', () => {
    it('entrelacement forcé : la désactivation attend, voit la course et refuse', async () => {
      const held = await holdTransaction(prisma, (tx) =>
        acceptLikeOffer(tx, A),
      );
      const off = drivers.deactivate(A, { reason: 'test' }, ADMIN);
      off.catch(() => undefined);
      // Avant F3-12.0 : le contrôle « occupé » passait (acceptation non
      // commise), `DriverProfile` était écrit, puis `User` réécrit OFFLINE au
      // commit — livreur inactif titulaire d'une course ACCEPTER.
      await waitUntilBlocked(prisma);
      await held.commit();

      await expect(off).rejects.toBeInstanceOf(ConflictException);
      const { delivery, a, profileA } = await snapshot();
      expect(delivery.status).toBe(DeliveryStatus.ACCEPTER);
      expect(a.driverStatus).toBe(DriverStatus.ON_DELIVERY);
      expect(profileA.isActive).toBe(true);
    });

    it('entrelacement forcé, sens inverse : l’acceptation attend la désactivation, puis échoue', async () => {
      // La désactivation tient R4 (User OFFLINE) et R5 (profil inactif).
      const held = await holdTransaction(prisma, async (tx) => {
        await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${A} FOR UPDATE`;
        await tx.user.update({
          where: { id: A },
          data: { driverStatus: DriverStatus.OFFLINE },
        });
        await tx.driverProfile.update({
          where: { userId: A },
          data: { isActive: false },
        });
      });
      const accept = acceptLikeOfferTx(A);
      accept.catch(() => undefined);
      await waitUntilBlocked(prisma);
      await held.commit();

      await expect(accept).rejects.toBeInstanceOf(ConflictException);
      const { delivery, a } = await snapshot();
      expect(delivery.status).toBe(DeliveryStatus.EN_ATTENTE);
      expect(delivery.delivererId).toBeNull();
      expect(a.driverStatus).toBe(DriverStatus.OFFLINE);
    });

    it(`×${REPS} en parallèle : jamais inactif titulaire d'une course acceptée, 0 interblocage`, async () => {
      for (let i = 0; i < REPS; i++) {
        await reset();
        const results = await Promise.allSettled([
          acceptLikeOfferTx(A),
          drivers.deactivate(A, { reason: 'test' }, ADMIN),
        ]);
        expectOnlyBusinessRefusals(results);

        const { delivery, a, profileA } = await snapshot();
        const accepted = delivery.status === DeliveryStatus.ACCEPTER;
        // Exactement un des deux gestes a gagné.
        expect(accepted).toBe(profileA.isActive);
        expect(accepted).toBe(a.driverStatus === DriverStatus.ON_DELIVERY);
        if (!profileA.isActive) {
          expect(a.driverStatus).toBe(DriverStatus.OFFLINE);
        }
      }
    });
  });

  // ═════════════════════════════════════════════════════════════════════════
  // Test C — ACCEPT ∥ assignation manuelle (+ ordre des verrous, B4)
  // ═════════════════════════════════════════════════════════════════════════

  describe('C — acceptation ∥ assignation manuelle', () => {
    it(`×${REPS} acceptation de A ∥ réassignation à B : un seul titulaire, un seul journal ouvert`, async () => {
      for (let i = 0; i < REPS; i++) {
        await reset();
        await assignment.assignDeliverer(DELIVERY, A, OWNER_UID);

        const results = await Promise.allSettled([
          assignment.acceptDelivery(DELIVERY, A_UID),
          assignment.assignDeliverer(DELIVERY, B, ADMIN_UID),
        ]);
        expectOnlyBusinessRefusals(results);

        const { delivery, a, open } = await snapshot();
        // I1 : une seule main ouverte, et c'est le titulaire.
        expect(open).toHaveLength(1);
        expect(open[0].delivererId).toBe(delivery.delivererId);
        if (delivery.status === DeliveryStatus.ACCEPTER) {
          expect(delivery.delivererId).toBe(A);
          expect(a.driverStatus).toBe(DriverStatus.ON_DELIVERY);
        }
      }
    });

    it(`×${REPS} offre acceptée ∥ assignation manuelle : un seul livreur final`, async () => {
      for (let i = 0; i < REPS; i++) {
        await reset();
        const results = await Promise.allSettled([
          acceptLikeOfferTx(A),
          assignment.assignDeliverer(DELIVERY, B, ADMIN_UID),
        ]);
        expectOnlyBusinessRefusals(results);

        const { delivery, open } = await snapshot();
        const [accepted, assigned] = results;
        expect([A, B]).toContain(delivery.delivererId);
        if (
          accepted.status === 'fulfilled' &&
          assigned.status === 'fulfilled'
        ) {
          // Les deux ne passent qu'en SÉRIE : l'acceptation est commise avant
          // que l'assignation lise la course, qui voit alors A titulaire et le
          // RÉASSIGNE à B (geste légitime, CAS sur l'état lu). Jamais une
          // assignation qui aurait écrasé une acceptation qu'elle n'a pas vue.
          // (Vu sous charge CPU, gate finale du 27/09/2026.)
          expect(assigned.value).toMatchObject({
            message: expect.stringMatching(/réassigné/),
          });
          expect(delivery.delivererId).toBe(B);
          expect(delivery.status).toBe(DeliveryStatus.ASSIGNER);
          expect(open).toHaveLength(1);
          expect(open[0].delivererId).toBe(B);
        } else {
          expect(rejections(results)).toHaveLength(1);
        }
      }
    });

    it('acceptation commise AVANT la lecture de l’assignation : réassignation de A vers B, pas d’écrasement', async () => {
      await acceptLikeOfferTx(A);
      const out = await assignment.assignDeliverer(DELIVERY, B, ADMIN_UID);

      expect(out.message).toMatch(/réassigné/);
      const { delivery, open } = await snapshot();
      expect(delivery.delivererId).toBe(B);
      expect(delivery.status).toBe(DeliveryStatus.ASSIGNER);
      expect(open).toHaveLength(1);
    });

    it('ordre des verrous : réassignation (Order FOR SHARE → Delivery) ∥ récupération — aucun interblocage', async () => {
      await assignment.assignDeliverer(DELIVERY, A, OWNER_UID);
      await assignment.acceptDelivery(DELIVERY, A_UID);

      // Une réassignation (`_doAssign`) a pris R1 — la commande, en partagé —
      // et va revendiquer la course (R2), DANS LA MÊME transaction.
      const reassign = openTransaction(prisma);
      await reassign.step(
        (tx) =>
          tx.$queryRaw`SELECT status FROM "Order" WHERE id = ${ORDER} FOR SHARE`,
      );

      // La récupération démarre. Avant F3-12.0, elle revendiquait d'abord la
      // course (R2) puis bloquait sur l'UPDATE de la commande (R1) ; la
      // réassignation, en demandant R2, fermait le cycle ⇒ 40P01.
      const pickup = assignment.confirmPickup(DELIVERY, A_UID);
      pickup.catch(() => undefined);
      await waitUntilBlocked(prisma);

      // La réassignation revendique la course : avec R1 pris d'abord par la
      // récupération, rien ne la retient.
      const claimed = await reassign
        .step((tx) =>
          tx.delivery.updateMany({
            where: {
              id: DELIVERY,
              status: DeliveryStatus.ACCEPTER,
              delivererId: A,
            },
            data: { status: DeliveryStatus.ASSIGNER, delivererId: B },
          }),
        )
        .catch((e: unknown) => e);
      const committed = await reassign.commit().catch((e: unknown) => e);

      expect(isDeadlock(claimed)).toBe(false);
      expect(isDeadlock(committed)).toBe(false);
      expect(claimed).toEqual({ count: 1 });

      // La récupération relit une course passée à B : 409, pas 40P01.
      const outcome = await pickup.then(
        () => 'ok',
        (e: unknown) => e,
      );
      expect(isDeadlock(outcome)).toBe(false);
      expect(outcome).toBeInstanceOf(ConflictException);
    });

    it(`×${REPS} récupération ∥ réassignation : 0 interblocage, état cohérent`, async () => {
      for (let i = 0; i < REPS; i++) {
        await reset();
        await assignment.assignDeliverer(DELIVERY, A, OWNER_UID);
        await assignment.acceptDelivery(DELIVERY, A_UID);

        const results = await Promise.allSettled([
          assignment.confirmPickup(DELIVERY, A_UID),
          assignment.assignDeliverer(DELIVERY, B, ADMIN_UID),
        ]);
        expectOnlyBusinessRefusals(results);

        const { delivery, open } = await snapshot();
        const order = await prisma.order.findUniqueOrThrow({
          where: { id: ORDER },
        });
        expect(open).toHaveLength(1);
        expect(open[0].delivererId).toBe(delivery.delivererId);
        // Commande EN_ROUTE ⇔ course EN_TRANSIT (même transaction).
        expect(order.status === OrderStatus.EN_ROUTE).toBe(
          delivery.status === DeliveryStatus.EN_TRANSIT,
        );
      }
    });

    it(`×${REPS} livraison (LIVRER) ∥ réassignation : 0 interblocage, jamais LIVRER sans commande livrée`, async () => {
      for (let i = 0; i < REPS; i++) {
        await reset();
        await assignment.assignDeliverer(DELIVERY, A, OWNER_UID);
        await assignment.acceptDelivery(DELIVERY, A_UID);
        await assignment.confirmPickup(DELIVERY, A_UID);
        const { code } = await prisma.deliveryHandover.findUniqueOrThrow({
          where: { deliveryId: DELIVERY },
        });

        const results = await Promise.allSettled([
          deliveries.updateStatus(
            DELIVERY,
            DeliveryStatus.LIVRER as never,
            A_UID,
            undefined,
            code,
          ),
          assignment.assignDeliverer(DELIVERY, B, ADMIN_UID),
        ]);
        expectOnlyBusinessRefusals(results);

        const { delivery } = await snapshot();
        const order = await prisma.order.findUniqueOrThrow({
          where: { id: ORDER },
        });
        expect(order.status === OrderStatus.LIVRER).toBe(
          delivery.status === DeliveryStatus.LIVRER,
        );
      }
    });
  });

  // ═════════════════════════════════════════════════════════════════════════
  // Test D — annulation ∥ assignation (B4, B5)
  // ═════════════════════════════════════════════════════════════════════════

  describe('D — annulation ∥ assignation', () => {
    it('entrelacement forcé : l’assignation attend l’annulation, relit ANNULER et refuse', async () => {
      const held = await holdTransaction(prisma, (tx) => cancelOrder(tx));
      const assign = assignment.assignDeliverer(DELIVERY, A, OWNER_UID);
      assign.catch(() => undefined);
      // Avant F3-12.0 : aucun verrou sur la commande, l'assignation passait
      // pendant que l'annulation était en vol ⇒ commande ANNULER + course
      // ASSIGNER.
      await waitUntilBlocked(prisma);
      await held.commit();

      await expect(assign).rejects.toBeInstanceOf(BadRequestException);
      const { delivery, open } = await snapshot();
      expect(delivery.delivererId).toBeNull();
      expect(delivery.status).toBe(DeliveryStatus.EN_ATTENTE);
      expect(open).toHaveLength(0);
    });

    it('entrelacement forcé, par commande : aucune livraison vide créée sur une commande annulée', async () => {
      const held = await holdTransaction(prisma, (tx) =>
        cancelOrder(tx, ORDER_BARE),
      );
      const assign = assignment.assignDelivererToOrder(
        ORDER_BARE,
        A,
        OWNER_UID,
      );
      assign.catch(() => undefined);
      await waitUntilBlocked(prisma);
      await held.commit();

      await expect(assign).rejects.toBeInstanceOf(BadRequestException);
      expect(
        await prisma.delivery.count({ where: { orderId: ORDER_BARE } }),
      ).toBe(0);
    });

    it(`×${REPS} en parallèle : 0 interblocage ; si l'assignation passe, elle précède l'annulation`, async () => {
      for (let i = 0; i < REPS; i++) {
        await reset();
        const results = await Promise.allSettled([
          prisma.$transaction((tx) => cancelOrder(tx)),
          assignment.assignDeliverer(DELIVERY, A, OWNER_UID),
        ]);
        expectOnlyBusinessRefusals(results);
        // Les deux gestes ont pu réussir, mais seulement dans l'ordre
        // « assignation puis annulation » (la fermeture de la course revient
        // alors au listener `order.cancelled`). L'ordre inverse est exclu par
        // l'entrelacement forcé ci-dessus.
      }
    });
  });

  // ═════════════════════════════════════════════════════════════════════════
  // B5 — création de livraison concurrente
  // ═════════════════════════════════════════════════════════════════════════

  describe('B5 — deux assignations par commande sur une commande sans livraison', () => {
    it(`×${REPS} : jamais de P2002, une seule livraison, un seul titulaire`, async () => {
      for (let i = 0; i < REPS; i++) {
        await reset();
        const results = await Promise.allSettled([
          assignment.assignDelivererToOrder(ORDER_BARE, A, OWNER_UID),
          assignment.assignDelivererToOrder(ORDER_BARE, B, ADMIN_UID),
        ]);
        for (const err of rejections(results)) {
          // Le perdant perd sur le CAS de la course (409), jamais sur la
          // contrainte d'unicité (P2002) de sa création.
          expect(err).toBeInstanceOf(ConflictException);
          expect(JSON.stringify(err)).not.toMatch(/P2002/);
        }
        const rows = await prisma.delivery.findMany({
          where: { orderId: ORDER_BARE },
        });
        expect(rows).toHaveLength(1);
        expect([A, B]).toContain(rows[0].delivererId);
      }
    });
  });

  // ═════════════════════════════════════════════════════════════════════════
  // Test E — bannissement ∥ acceptation (B3)
  // ═════════════════════════════════════════════════════════════════════════

  describe('E — bannissement ∥ acceptation', () => {
    const ban = (tx: Prisma.TransactionClient) =>
      tx.user.update({
        where: { id: A },
        data: { statusUser: StatusUser.BLOCKED },
      });

    it('entrelacement forcé : l’acceptation attend le bannissement, puis est refusée', async () => {
      await assignment.assignDeliverer(DELIVERY, A, OWNER_UID);

      const held = await holdTransaction(prisma, ban);
      const accept = assignment.acceptDelivery(DELIVERY, A_UID);
      accept.catch(() => undefined);
      // Avant F3-12.0 : le CAS ne regardait que `driverStatus`, et le cache
      // de `RolesGuard` (5 min) laissait passer le banni ⇒ course acceptée.
      await waitUntilBlocked(prisma);
      await held.commit();

      await expect(accept).rejects.toBeInstanceOf(ForbiddenException);
      const { delivery, a } = await snapshot();
      expect(delivery.status).toBe(DeliveryStatus.ASSIGNER);
      expect(delivery.driverEconomicsFrozenAt).toBeNull();
      expect(a.driverStatus).toBe(DriverStatus.AVAILABLE);
    });

    it('changement de rôle commis avant l’acceptation : refusée', async () => {
      await assignment.assignDeliverer(DELIVERY, A, OWNER_UID);
      await prisma.user.update({
        where: { id: A },
        data: { role: Role.CLIENT },
      });
      await expect(
        assignment.acceptDelivery(DELIVERY, A_UID),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('profil désactivé resté AVAILABLE : acceptation refusée', async () => {
      await assignment.assignDeliverer(DELIVERY, A, OWNER_UID);
      await prisma.driverProfile.update({
        where: { userId: A },
        data: { isActive: false },
      });
      await expect(
        assignment.acceptDelivery(DELIVERY, A_UID),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect((await snapshot()).delivery.status).toBe(DeliveryStatus.ASSIGNER);
    });

    it(`×${REPS} en parallèle : un banni ne finit jamais titulaire d'une course acceptée APRÈS son bannissement`, async () => {
      for (let i = 0; i < REPS; i++) {
        await reset();
        await assignment.assignDeliverer(DELIVERY, A, OWNER_UID);

        let bannedAt: Date | null = null;
        const results = await Promise.allSettled([
          prisma.$transaction(async (tx) => {
            await ban(tx);
            const [{ now }] = await tx.$queryRaw<{ now: Date }[]>`
              SELECT clock_timestamp() AS now`;
            bannedAt = now;
          }),
          assignment.acceptDelivery(DELIVERY, A_UID),
        ]);
        expectOnlyBusinessRefusals(results);

        const { delivery } = await snapshot();
        if (delivery.status === DeliveryStatus.ACCEPTER) {
          // L'acceptation a gagné : elle a été écrite avant le bannissement.
          expect(delivery.acceptedAt!.getTime()).toBeLessThanOrEqual(
            bannedAt!.getTime(),
          );
        }
      }
    });
  });

  // ═════════════════════════════════════════════════════════════════════════
  // Test F — acceptation ∥ annulation, acceptation ∥ changement de rôle
  // ═════════════════════════════════════════════════════════════════════════

  describe('F — acceptation ∥ annulation / changement de rôle', () => {
    it('entrelacement forcé : l’acceptation attend l’annulation, relit ANNULER et refuse', async () => {
      await assignment.assignDeliverer(DELIVERY, A, OWNER_UID);

      const held = await holdTransaction(prisma, (tx) => cancelOrder(tx));
      const accept = assignment.acceptDelivery(DELIVERY, A_UID);
      accept.catch(() => undefined);
      // `Order FOR SHARE` (R1) attend le `FOR UPDATE` de l'annulation.
      await waitUntilBlocked(prisma);
      await held.commit();

      await expect(accept).rejects.toBeInstanceOf(ConflictException);
      const { delivery, a } = await snapshot();
      expect(delivery.status).toBe(DeliveryStatus.ASSIGNER);
      expect(delivery.driverEconomicsFrozenAt).toBeNull();
      expect(a.driverStatus).toBe(DriverStatus.AVAILABLE);
    });

    it(`×${REPS} en parallèle : 0 interblocage ; jamais une course acceptée sur une commande annulée avant elle`, async () => {
      for (let i = 0; i < REPS; i++) {
        await reset();
        await assignment.assignDeliverer(DELIVERY, A, OWNER_UID);

        let cancelledAt: Date | null = null;
        const results = await Promise.allSettled([
          prisma.$transaction(async (tx) => {
            await cancelOrder(tx);
            const [{ now }] = await tx.$queryRaw<{ now: Date }[]>`
              SELECT clock_timestamp() AS now`;
            cancelledAt = now;
          }),
          assignment.acceptDelivery(DELIVERY, A_UID),
        ]);
        expectOnlyBusinessRefusals(results);

        const { delivery, a } = await snapshot();
        expect(delivery.status === DeliveryStatus.ACCEPTER).toBe(
          a.driverStatus === DriverStatus.ON_DELIVERY,
        );
        if (delivery.status === DeliveryStatus.ACCEPTER && cancelledAt) {
          // Les deux ont réussi : l'acceptation précède l'annulation (la
          // fermeture de la course revient alors au listener).
          expect(delivery.acceptedAt!.getTime()).toBeLessThanOrEqual(
            (cancelledAt as Date).getTime(),
          );
        }
      }
    });

    it('entrelacement forcé : l’acceptation attend le changement de rôle, puis est refusée', async () => {
      await assignment.assignDeliverer(DELIVERY, A, OWNER_UID);

      // Même écriture que `admin-users.service.updateRole` (LIVREUR → CLIENT).
      const held = await holdTransaction(prisma, async (tx) => {
        await tx.user.update({
          where: { id: A },
          data: { driverStatus: null },
        });
        await tx.user.update({ where: { id: A }, data: { role: Role.CLIENT } });
      });
      const accept = assignment.acceptDelivery(DELIVERY, A_UID);
      accept.catch(() => undefined);
      await waitUntilBlocked(prisma);
      await held.commit();

      await expect(accept).rejects.toBeInstanceOf(ForbiddenException);
      const { delivery, a } = await snapshot();
      expect(delivery.status).toBe(DeliveryStatus.ASSIGNER);
      expect(delivery.driverEconomicsFrozenAt).toBeNull();
      expect(a.driverStatus).toBeNull();
    });
  });

  // ═════════════════════════════════════════════════════════════════════════
  // Suppression de compte ∥ désactivation (R4 → R5 des deux côtés)
  // ═════════════════════════════════════════════════════════════════════════

  describe('suppression de compte ∥ désactivation', () => {
    it('ordre des verrous : la suppression prend User (R4) avant le profil (R5) — aucun interblocage', async () => {
      const deletion = new UserDeletionService(
        prisma as never,
        { deleteUserSafe: async () => undefined } as never,
        { invalidateOrThrow: async () => undefined } as never,
      );

      // La désactivation tient le livreur (R4) et va écrire son profil (R5),
      // DANS LA MÊME transaction.
      const deactivate = openTransaction(prisma);
      await deactivate.step(
        (tx) => tx.$queryRaw`SELECT id FROM "User" WHERE id = ${A} FOR UPDATE`,
      );

      // La suppression démarre. Avant le correctif, elle supprimait le profil
      // (R5) puis attendait `User` (R4) : la désactivation, en demandant R5,
      // fermait le cycle ⇒ 40P01.
      const deleted = deletion.deleteOwnAccount(A);
      deleted.catch(() => undefined);
      await waitUntilBlocked(prisma);

      const wrote = await deactivate
        .step((tx) =>
          tx.driverProfile.updateMany({
            where: { userId: A, isActive: true },
            data: { isActive: false },
          }),
        )
        .catch((e: unknown) => e);
      const committed = await deactivate.commit().catch((e: unknown) => e);
      const outcome = await deleted.then(
        () => 'ok',
        (e: unknown) => e,
      );

      expect(isDeadlock(wrote)).toBe(false);
      expect(isDeadlock(committed)).toBe(false);
      expect(isDeadlock(outcome)).toBe(false);
      expect(outcome).toBe('ok');

      // Remise en état du livreur anonymisé pour les tests suivants.
      await prisma.user.update({
        where: { id: A },
        data: {
          firebaseUid: A_UID,
          email: 'f120-a@test.local',
          nom: 'Livreur A',
          statusUser: StatusUser.ACTIVE,
        },
      });
      await prisma.driverProfile.create({
        data: {
          userId: A,
          vehicleType: 'MOTO',
          isActive: true,
          employmentType: 'LILIA',
          compensationModel: 'PER_DELIVERY',
        },
      });
    });
  });

  // ═════════════════════════════════════════════════════════════════════════
  // Assignation ∥ désactivation (R4 relu sous verrou dans _doAssign)
  // ═════════════════════════════════════════════════════════════════════════

  describe('assignation ∥ désactivation du livreur désigné', () => {
    it('entrelacement forcé : l’assignation attend, relit le profil inactif et refuse', async () => {
      const held = await holdTransaction(prisma, async (tx) => {
        await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${A} FOR UPDATE`;
        await tx.user.update({
          where: { id: A },
          data: { driverStatus: DriverStatus.OFFLINE },
        });
        await tx.driverProfile.update({
          where: { userId: A },
          data: { isActive: false },
        });
      });
      const assign = assignment.assignDeliverer(DELIVERY, A, OWNER_UID);
      assign.catch(() => undefined);
      await waitUntilBlocked(prisma);
      await held.commit();

      await expect(assign).rejects.toBeInstanceOf(ForbiddenException);
      const { delivery, open } = await snapshot();
      expect(delivery.delivererId).toBeNull();
      expect(open).toHaveLength(0);
    });

    it('entrelacement forcé, sens inverse : la désactivation attend l’assignation, voit la mission et refuse', async () => {
      // Écritures de `_doAssign`, dans son ordre : R1 → R2 → R4. Une
      // assignation ne change pas `driverStatus` : seul le verrou `User` de
      // `deactivate` (pas son CAS) lui fait voir la mission.
      const held = await holdTransaction(prisma, async (tx) => {
        await tx.$queryRaw`SELECT status FROM "Order" WHERE id = ${ORDER} FOR SHARE`;
        await tx.delivery.update({
          where: { id: DELIVERY },
          data: { status: DeliveryStatus.ASSIGNER, delivererId: A },
        });
        await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${A} FOR UPDATE`;
      });
      const off = drivers.deactivate(A, { reason: 'test' }, ADMIN);
      off.catch(() => undefined);
      await waitUntilBlocked(prisma);
      await held.commit();

      await expect(off).rejects.toBeInstanceOf(ConflictException);
      const { delivery, profileA } = await snapshot();
      expect(delivery.delivererId).toBe(A);
      expect(profileA.isActive).toBe(true);
    });

    it(`×${REPS} en parallèle : jamais un livreur inactif avec une mission ouverte`, async () => {
      for (let i = 0; i < REPS; i++) {
        await reset();
        const results = await Promise.allSettled([
          assignment.assignDeliverer(DELIVERY, A, OWNER_UID),
          drivers.deactivate(A, { reason: 'test' }, ADMIN),
        ]);
        expectOnlyBusinessRefusals(results);

        const { delivery, profileA } = await snapshot();
        expect(!profileA.isActive && delivery.delivererId === A).toBe(false);
      }
    });
  });
});
