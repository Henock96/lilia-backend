import { PrismaPg } from '@prisma/adapter-pg';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  DeliveryAssignmentOutcome,
  DeliveryStatus,
  OrderStatus,
  PrismaClient,
} from '@prisma/client';

import { DeliveryAssignmentLogService } from '../../apps/lilia-app/src/modules/deliveries/delivery-assignment-log.service';
import { DeliveryAssignmentService } from '../../apps/lilia-app/src/modules/deliveries/delivery-assignment.service';
import { OrderStateMachine } from '../../apps/lilia-app/src/modules/orders/order-state.machine';
import { OrderTransitionService } from '../../apps/lilia-app/src/modules/orders/order-transition.service';
import { PlatformSettingsService } from '../../apps/lilia-app/src/modules/platform-settings/platform-settings.service';

/**
 * **Le dispatch, contre un vrai PostgreSQL.**
 *
 * Deux propriétés de ce chantier ne peuvent PAS être prouvées sur un double :
 *
 * 1. **La concurrence.** Un test unitaire qui simule deux transactions simule
 *    aussi leur ordonnancement — c'est-à-dire précisément ce qu'on prétend
 *    vérifier. Ici, les deux `assignDeliverer` partent réellement en parallèle
 *    contre la même ligne, et c'est PostgreSQL qui arbitre.
 * 2. **Le journal d'assignation.** Nouvelle table, nouveau type énuméré,
 *    nouvelles clés étrangères. Une valeur d'enum mal orthographiée ou une
 *    colonne absente de la migration ne se voit sur aucun mock.
 *
 * Se saute proprement sans `TEST_DATABASE_URL`.
 */
const DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

describeIfDb(
  'Dispatch livreur — concurrence et journal (PostgreSQL réel)',
  () => {
    let prisma: PrismaClient;
    let assignment: DeliveryAssignmentService;

    const OWNER = 'dd-owner';
    const OWNER_UID = 'fb-dd-owner';
    const ADMIN = 'dd-admin';
    const ADMIN_UID = 'fb-dd-admin';
    const CLIENT = 'dd-client';
    const DRIVER_A = 'dd-driver-a';
    const DRIVER_B = 'dd-driver-b';
    const VENDOR = 'dd-vendor';
    const ORDER = 'dd-order';
    const DELIVERY = 'dd-delivery';

    /** Ramène la course à l'état « aucun livreur », journal vidé. */
    const reset = async () => {
      await prisma.deliveryAssignment.deleteMany({
        where: { deliveryId: DELIVERY },
      });
      await prisma.delivery.update({
        where: { id: DELIVERY },
        data: {
          delivererId: null,
          status: DeliveryStatus.EN_ATTENTE,
          driverBaseXaf: null,
          driverEmploymentType: null,
          driverCompensationModel: null,
          driverSharePercent: null,
          driverPayXaf: null,
          driverEconomicsFrozenAt: null,
          driverSettlementId: null,
        },
      });
      await prisma.order.update({
        where: { id: ORDER },
        data: { status: OrderStatus.PRET },
      });
      await prisma.user.updateMany({
        where: { id: { in: [DRIVER_A, DRIVER_B] } },
        data: { driverStatus: 'AVAILABLE' },
      });
    };

    beforeAll(async () => {
      prisma = new PrismaClient({
        adapter: new PrismaPg({ connectionString: DATABASE_URL }),
      });
      await prisma.$connect();

      assignment = new DeliveryAssignmentService(
        prisma as never,
        new EventEmitter2(),
        new OrderStateMachine(),
        new OrderTransitionService(),
        new PlatformSettingsService(prisma as never),
        new DeliveryAssignmentLogService(),
        // Le tracking n'est pas exercé ici ; seule la purge de position est
        // appelée à la réassignation, et elle est best-effort.
        { forgetLastPosition: async () => undefined } as never,
      );

      await prisma.$executeRawUnsafe(`
      TRUNCATE TABLE "DeliveryAssignment", "DeliveryReview", "DeliveryLocation",
                     "Delivery", "OrderItem", "OrderHistory", "Order",
                     "DriverProfile", "Restaurant", "User"
      RESTART IDENTITY CASCADE
    `);

      await prisma.user.createMany({
        data: [
          { id: CLIENT, firebaseUid: 'fb-dd-c', email: 'dd-c@test.local' },
          {
            id: OWNER,
            firebaseUid: OWNER_UID,
            email: 'dd-o@test.local',
            role: 'RESTAURATEUR',
          },
          {
            id: ADMIN,
            firebaseUid: ADMIN_UID,
            email: 'dd-adm@test.local',
            role: 'ADMIN',
          },
          {
            id: DRIVER_A,
            firebaseUid: 'fb-dd-a',
            email: 'dd-a@test.local',
            nom: 'Livreur A',
            role: 'LIVREUR',
            driverStatus: 'AVAILABLE',
          },
          {
            id: DRIVER_B,
            firebaseUid: 'fb-dd-b',
            email: 'dd-b@test.local',
            nom: 'Livreur B',
            role: 'LIVREUR',
            driverStatus: 'AVAILABLE',
          },
        ],
      });

      await prisma.driverProfile.createMany({
        data: [
          {
            userId: DRIVER_A,
            vehicleType: 'MOTO',
            isActive: true,
            employmentType: 'LILIA',
            compensationModel: 'PER_DELIVERY',
          },
          {
            userId: DRIVER_B,
            vehicleType: 'MOTO',
            isActive: true,
            employmentType: 'INDEPENDENT',
            compensationModel: 'PER_DELIVERY',
          },
        ],
      });

      await prisma.restaurant.create({
        data: {
          id: VENDOR,
          nom: 'Chez Dispatch',
          adresse: 'Bacongo',
          phone: '060000010',
          ownerId: OWNER,
        },
      });

      await prisma.order.create({
        data: {
          id: ORDER,
          restaurantId: VENDOR,
          userId: CLIENT,
          subTotal: 5000,
          deliveryFee: 1000,
          deliveryFeeGross: 1000,
          serviceFee: 400,
          total: 6400,
          paymentMethod: 'MTN_MOMO',
          status: OrderStatus.PRET,
        },
      });

      await prisma.delivery.create({
        data: {
          id: DELIVERY,
          orderId: ORDER,
          status: DeliveryStatus.EN_ATTENTE,
        },
      });
    });

    afterAll(async () => {
      await prisma.$disconnect();
    });

    beforeEach(reset);

    // ═══════════════════════════════════════════════════════════════════════════

    it('deux assignations simultanées : une seule réussit, la base arbitre', async () => {
      const [a, b] = await Promise.allSettled([
        assignment.assignDeliverer(DELIVERY, DRIVER_A, OWNER_UID),
        assignment.assignDeliverer(DELIVERY, DRIVER_B, ADMIN_UID),
      ]);

      // Exactement une réussite. Avant le verrou optimiste, les DEUX passaient :
      // chacune lisait `delivererId = null` hors transaction, et la dernière
      // écriture gagnait en silence — pendant que les deux livreurs recevaient
      // « 🚚 Nouvelle mission ».
      const reussies = [a, b].filter((r) => r.status === 'fulfilled');
      expect(reussies).toHaveLength(1);

      const course = await prisma.delivery.findUniqueOrThrow({
        where: { id: DELIVERY },
      });
      expect([DRIVER_A, DRIVER_B]).toContain(course.delivererId);
      expect(course.status).toBe(DeliveryStatus.ASSIGNER);

      // Et une seule ligne de journal, ouverte au nom du gagnant.
      const journal = await prisma.deliveryAssignment.findMany({
        where: { deliveryId: DELIVERY },
      });
      expect(journal).toHaveLength(1);
      expect(journal[0].delivererId).toBe(course.delivererId);
      expect(journal[0].releasedAt).toBeNull();
    });

    it('le journal garde les deux mains et nomme qui a réassigné', async () => {
      await assignment.assignDeliverer(DELIVERY, DRIVER_A, OWNER_UID);
      await assignment.assignDeliverer(DELIVERY, DRIVER_B, ADMIN_UID);

      const journal = await prisma.deliveryAssignment.findMany({
        where: { deliveryId: DELIVERY },
        orderBy: { assignedAt: 'asc' },
      });

      expect(journal).toHaveLength(2);
      expect(journal[0]).toMatchObject({
        delivererId: DRIVER_A,
        assignedByUserId: OWNER,
        assignedByRole: 'RESTAURATEUR',
        outcome: DeliveryAssignmentOutcome.REASSIGNED,
      });
      expect(journal[0].releasedAt).toBeInstanceOf(Date);
      expect(journal[1]).toMatchObject({
        delivererId: DRIVER_B,
        assignedByUserId: ADMIN,
        assignedByRole: 'ADMIN',
        outcome: null,
      });
      expect(journal[1].releasedAt).toBeNull();
    });

    it('une seule main ouverte à la fois, quelle que soit la suite', async () => {
      await assignment.assignDeliverer(DELIVERY, DRIVER_A, OWNER_UID);
      await assignment.assignDeliverer(DELIVERY, DRIVER_B, OWNER_UID);
      await assignment.assignDeliverer(DELIVERY, DRIVER_A, ADMIN_UID);

      const ouvertes = await prisma.deliveryAssignment.count({
        where: { deliveryId: DELIVERY, releasedAt: null },
      });
      expect(ouvertes).toBe(1);
    });

    it('le refus clôt la main du livreur et rend la course assignable', async () => {
      await assignment.assignDeliverer(DELIVERY, DRIVER_A, OWNER_UID);
      await assignment.declineDelivery(DELIVERY, 'fb-dd-a', 'trop loin');

      const course = await prisma.delivery.findUniqueOrThrow({
        where: { id: DELIVERY },
      });
      expect(course.delivererId).toBeNull();
      expect(course.status).toBe(DeliveryStatus.EN_ATTENTE);

      const [ligne] = await prisma.deliveryAssignment.findMany({
        where: { deliveryId: DELIVERY },
      });
      expect(ligne).toMatchObject({
        delivererId: DRIVER_A,
        outcome: DeliveryAssignmentOutcome.DECLINED,
        releaseReason: 'trop loin',
      });
    });

    it('acceptation et récupération horodatent la main courante', async () => {
      await assignment.assignDeliverer(DELIVERY, DRIVER_A, OWNER_UID);
      await assignment.acceptDelivery(DELIVERY, 'fb-dd-a');
      await assignment.confirmPickup(DELIVERY, 'fb-dd-a');

      const [ligne] = await prisma.deliveryAssignment.findMany({
        where: { deliveryId: DELIVERY },
      });
      expect(ligne.acceptedAt).toBeInstanceOf(Date);
      expect(ligne.pickedUpAt).toBeInstanceOf(Date);

      const commande = await prisma.order.findUniqueOrThrow({
        where: { id: ORDER },
      });
      expect(commande.status).toBe(OrderStatus.EN_ROUTE);
    });

    /**
     * LE défaut : après une récupération, la commande est `EN_ROUTE`. Le livreur
     * suivant butait sur `EN_ROUTE → EN_ROUTE`, transition qui n'existe pas —
     * et `LIVRER` n'étant atteignable que depuis `EN_TRANSIT`, la commande
     * devenait définitivement non livrable.
     */
    it('reprise après échec : le second livreur peut récupérer et partir', async () => {
      await assignment.assignDeliverer(DELIVERY, DRIVER_A, OWNER_UID);
      await assignment.acceptDelivery(DELIVERY, 'fb-dd-a');
      await assignment.confirmPickup(DELIVERY, 'fb-dd-a');

      // Échec en pleine course : la commande RESTE en route, volontairement.
      await prisma.delivery.update({
        where: { id: DELIVERY },
        data: { status: DeliveryStatus.ECHEC, delivererId: null },
      });
      await prisma.user.update({
        where: { id: DRIVER_A },
        data: { driverStatus: 'AVAILABLE' },
      });

      await assignment.assignDeliverer(DELIVERY, DRIVER_B, OWNER_UID);
      await assignment.acceptDelivery(DELIVERY, 'fb-dd-b');
      await assignment.confirmPickup(DELIVERY, 'fb-dd-b');

      const course = await prisma.delivery.findUniqueOrThrow({
        where: { id: DELIVERY },
      });
      expect(course.status).toBe(DeliveryStatus.EN_TRANSIT);
      expect(course.delivererId).toBe(DRIVER_B);
      // 65 % de 1 000 F : l'économie est celle de B, l'indépendant.
      expect(course.driverPayXaf).toBe(650);
    });

    it('une course livrée ne change plus de livreur', async () => {
      await assignment.assignDeliverer(DELIVERY, DRIVER_A, OWNER_UID);
      await prisma.delivery.update({
        where: { id: DELIVERY },
        data: { status: DeliveryStatus.LIVRER, driverPayXaf: 350 },
      });
      await prisma.order.update({
        where: { id: ORDER },
        data: { status: OrderStatus.LIVRER },
      });

      await expect(
        assignment.assignDeliverer(DELIVERY, DRIVER_B, ADMIN_UID),
      ).rejects.toThrow();

      const course = await prisma.delivery.findUniqueOrThrow({
        where: { id: DELIVERY },
      });
      expect(course.delivererId).toBe(DRIVER_A);
      expect(course.driverPayXaf).toBe(350);
    });

    it('supprimer une livraison emporte son journal (cascade)', async () => {
      await assignment.assignDeliverer(DELIVERY, DRIVER_A, OWNER_UID);
      expect(
        await prisma.deliveryAssignment.count({
          where: { deliveryId: DELIVERY },
        }),
      ).toBe(1);

      await prisma.delivery.delete({ where: { id: DELIVERY } });
      expect(
        await prisma.deliveryAssignment.count({
          where: { deliveryId: DELIVERY },
        }),
      ).toBe(0);

      // On la recrée pour ne pas casser les tests suivants (`beforeEach` la met à
      // jour, il ne la crée pas).
      await prisma.delivery.create({
        data: {
          id: DELIVERY,
          orderId: ORDER,
          status: DeliveryStatus.EN_ATTENTE,
        },
      });
    });

    // ═══ Fix F-03 (Master Audit v1) — acceptation ════════════════════════════

    describe('F-03 — l’acceptation vérifie l’état COURANT, atomiquement', () => {
      it('A accepte une mission qui vient d’être réassignée à B : 409, rien ne bouge', async () => {
        await assignment.assignDeliverer(DELIVERY, DRIVER_A, OWNER_UID);
        // Instantané périmé côté A : on simule la lecture faite AVANT la
        // réassignation en la rejouant après — le serveur doit relire.
        await assignment.assignDeliverer(DELIVERY, DRIVER_B, OWNER_UID);

        await expect(
          assignment.acceptDelivery(DELIVERY, 'fb-dd-a'),
        ).rejects.toThrow();

        const course = await prisma.delivery.findUniqueOrThrow({
          where: { id: DELIVERY },
        });
        expect(course).toMatchObject({
          delivererId: DRIVER_B,
          status: DeliveryStatus.ASSIGNER,
          driverPayXaf: null,
        });
        const a = await prisma.user.findUniqueOrThrow({
          where: { id: DRIVER_A },
        });
        expect(a.driverStatus).toBe('AVAILABLE');
      });

      it('course acceptation (A) / réassignation (→ B) en parallèle : jamais de course acceptée au nom d’un autre', async () => {
        for (let round = 0; round < 10; round++) {
          await reset();
          await assignment.assignDeliverer(DELIVERY, DRIVER_A, OWNER_UID);

          await Promise.allSettled([
            assignment.acceptDelivery(DELIVERY, 'fb-dd-a'),
            assignment.assignDeliverer(DELIVERY, DRIVER_B, ADMIN_UID),
          ]);

          const course = await prisma.delivery.findUniqueOrThrow({
            where: { id: DELIVERY },
          });
          const users = await prisma.user.findMany({
            where: { id: { in: [DRIVER_A, DRIVER_B] } },
          });
          const onDelivery = users
            .filter((u) => u.driverStatus === 'ON_DELIVERY')
            .map((u) => u.id);

          if (course.status === DeliveryStatus.ACCEPTER) {
            // Accepté : c'est forcément A, et A seul est en course.
            expect(course.delivererId).toBe(DRIVER_A);
            expect(onDelivery).toEqual([DRIVER_A]);
          } else {
            // Réassigné : B attend sa réponse, personne n'est en course.
            expect(course).toMatchObject({
              status: DeliveryStatus.ASSIGNER,
              delivererId: DRIVER_B,
            });
            expect(onDelivery).toEqual([]);
          }
        }
      });

      it('un livreur accepte deux missions en même temps : une seule passe', async () => {
        const ORDER_2 = 'dd-order-2';
        const DELIVERY_2 = 'dd-delivery-2';
        await prisma.order.create({
          data: {
            id: ORDER_2,
            restaurantId: VENDOR,
            userId: CLIENT,
            subTotal: 3000,
            deliveryFee: 1000,
            deliveryFeeGross: 1000,
            total: 4000,
            paymentMethod: 'MTN_MOMO',
            status: OrderStatus.PRET,
          },
        });
        await prisma.delivery.create({
          data: {
            id: DELIVERY_2,
            orderId: ORDER_2,
            status: DeliveryStatus.EN_ATTENTE,
          },
        });
        try {
          await assignment.assignDeliverer(DELIVERY, DRIVER_A, OWNER_UID);
          await assignment.assignDeliverer(DELIVERY_2, DRIVER_A, OWNER_UID);

          const results = await Promise.allSettled([
            assignment.acceptDelivery(DELIVERY, 'fb-dd-a'),
            assignment.acceptDelivery(DELIVERY_2, 'fb-dd-a'),
          ]);
          expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(
            1,
          );

          const acceptees = await prisma.delivery.count({
            where: {
              id: { in: [DELIVERY, DELIVERY_2] },
              status: DeliveryStatus.ACCEPTER,
            },
          });
          expect(acceptees).toBe(1);
        } finally {
          await prisma.deliveryAssignment.deleteMany({
            where: { deliveryId: DELIVERY_2 },
          });
          await prisma.delivery.delete({ where: { id: DELIVERY_2 } });
          await prisma.orderHistory.deleteMany({ where: { orderId: ORDER_2 } });
          await prisma.order.delete({ where: { id: ORDER_2 } });
        }
      });

      it('commande annulée après l’assignation : l’acceptation est refusée', async () => {
        await assignment.assignDeliverer(DELIVERY, DRIVER_A, OWNER_UID);
        await prisma.order.update({
          where: { id: ORDER },
          data: { status: OrderStatus.ANNULER },
        });

        await expect(
          assignment.acceptDelivery(DELIVERY, 'fb-dd-a'),
        ).rejects.toThrow(/plus à livrer/);
        const a = await prisma.user.findUniqueOrThrow({
          where: { id: DRIVER_A },
        });
        expect(a.driverStatus).toBe('AVAILABLE');
      });
    });
  },
);
