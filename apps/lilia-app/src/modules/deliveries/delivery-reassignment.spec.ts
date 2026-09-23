import { AdminAuditService } from '../admin-audit/admin-audit.service';
import { OutboxService } from '../outbox/outbox.service';
import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  DeliveryAssignmentOutcome,
  DeliveryStatus,
  DriverStatus,
  OrderStatus,
} from '@prisma/client';

import { DeliveriesService } from './deliveries.service';
import { DeliveryQueryService } from './delivery-query.service';
import { DeliveryAssignmentService } from './delivery-assignment.service';
import { DeliveryAssignmentLogService } from './delivery-assignment-log.service';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { OrderStateMachine } from '../orders/order-state.machine';
import { OrderTransitionService } from '../orders/order-transition.service';
import { PlatformSettingsService } from '../platform-settings/platform-settings.service';
import { TrackingGateway } from '../tracking/tracking.gateway';
import { TrackingService } from '../tracking/tracking.service';
import { LoyaltyService } from '../loyalty/loyalty.service';
import { ReferralService } from '../users/referral.service';

/**
 * Le cycle de vie d'une course, joué en entier — y compris quand elle change
 * de mains.
 *
 * Les specs existantes vérifient chaque geste isolément, chacune repartant de
 * son propre mock. Aucune ne pouvait donc attraper ce que seul un ENCHAÎNEMENT
 * révèle : que la course réassignée après récupération devenait définitivement
 * non livrable, parce que `confirmPickup` rejouait `PRET → EN_ROUTE` sur une
 * commande déjà `EN_ROUTE`. Chaque étape passait ; la suite était un mur.
 *
 * Le magasin ci-dessous est volontairement minuscule et **avec état** : les
 * écritures d'une étape sont lues par la suivante, et un `updateMany` ne
 * compte que si son `where` correspond réellement — c'est ce qui rend les
 * verrous optimistes exerçables au lieu d'être supposés.
 */
describe('Dispatch livreur — cycle complet et réassignation', () => {
  let service: DeliveriesService;
  let emitter: { emit: jest.Mock };

  const OWNER_UID = 'fb-vendeur';
  const ADMIN_UID = 'fb-admin';
  const CLIENT_ID = 'u-client';

  type Row = Record<string, any>;

  /** Livraison, commande, livreurs et journal — en mémoire. */
  let delivery: Row;
  let order: Row;
  let users: Record<string, Row>;
  /** Codes de remise par course (F-06). */
  let handovers: Record<string, Row> = {};
  let assignments: Row[];
  /** Positions GPS persistées — le fallback HTTP écrit en base. */
  let positions: Row[];
  const loyalty = { awardForDeliveredOrder: jest.fn() };
  const referral = { rewardForDeliveredOrder: jest.fn() };
  const trackingService = {
    cacheLivePosition: jest.fn(),
    calculateETA: jest.fn(),
    forgetLastPosition: jest.fn(),
  };
  const trackingGateway = { broadcastDriverPosition: jest.fn() };

  const driver = (id: string): Row => ({
    id,
    firebaseUid: `fb-${id}`,
    nom: id.toUpperCase(),
    role: 'LIVREUR',
    statusUser: 'ACTIVE',
    driverStatus: DriverStatus.AVAILABLE,
    driverProfile: {
      isActive: true,
      employmentType: 'LILIA',
      compensationModel: 'REVENUE_SHARE',
      driverSharePercent: null,
    },
  });

  /** Vue « livraison + relations » telle que les services la chargent. */
  const deliveryWithRelations = () => ({
    ...delivery,
    order: {
      ...order,
      restaurant: {
        nom: 'Chez Awa',
        owner: { firebaseUid: OWNER_UID },
      },
    },
    deliverer: delivery.delivererId ? users[delivery.delivererId] : null,
  });

  /** `updateMany` honnête : le `where` est réellement évalué. */
  const matches = (row: Row, where: Row) =>
    Object.entries(where).every(([k, v]) => {
      if (v !== null && typeof v === 'object' && 'in' in v) {
        return (v.in as unknown[]).includes(row[k]);
      }
      return row[k] === v;
    });

  /** File d'attente des transactions — une seule à la fois. */
  let txQueue: Promise<unknown> = Promise.resolve();
  const runSerialized = <T>(work: () => Promise<T>): Promise<T> => {
    const result = txQueue.then(work, work);
    txQueue = result.catch(() => undefined);
    return result;
  };

  const tx = {
    delivery: {
      updateMany: jest.fn(({ where, data }: Row) => {
        if (!matches(delivery, where)) return Promise.resolve({ count: 0 });
        Object.assign(delivery, data);
        return Promise.resolve({ count: 1 });
      }),
      findUniqueOrThrow: jest.fn(() =>
        Promise.resolve(deliveryWithRelations()),
      ),
    },
    order: {
      updateMany: jest.fn(({ where, data }: Row) => {
        if (!matches(order, where)) return Promise.resolve({ count: 0 });
        Object.assign(order, data);
        return Promise.resolve({ count: 1 });
      }),
      count: jest.fn(({ where }: Row) =>
        Promise.resolve(matches(order, where) ? 1 : 0),
      ),
      findUniqueOrThrow: jest.fn(() => Promise.resolve(order)),
    },
    orderHistory: { create: jest.fn(() => Promise.resolve({})) },
    user: {
      update: jest.fn(({ where, data }: Row) => {
        Object.assign(users[where.id], data);
        return Promise.resolve(users[where.id]);
      }),
      updateMany: jest.fn(({ where, data }: Row) => {
        const row = users[where.id];
        if (!row || !matches(row, where)) return Promise.resolve({ count: 0 });
        Object.assign(row, data);
        return Promise.resolve({ count: 1 });
      }),
    },
    // Code de remise tiré au retrait (F-06).
    deliveryHandover: {
      upsert: jest.fn(({ where, create }: Row) => {
        handovers[where.deliveryId] ??= { ...create, attempts: 0 };
        return Promise.resolve(handovers[where.deliveryId]);
      }),
    },
    // `SELECT status FROM "Order" … FOR SHARE` à l'acceptation (fix F-03).
    $queryRaw: jest.fn(() => Promise.resolve([{ status: order.status }])),
    deliveryAssignment: {
      create: jest.fn(({ data }: Row) => {
        assignments.push({ ...data, releasedAt: null, outcome: null });
        return Promise.resolve({});
      }),
      updateMany: jest.fn(({ where, data }: Row) => {
        const open = assignments.filter((a) => matches(a, where));
        open.forEach((a) => Object.assign(a, data));
        return Promise.resolve({ count: open.length });
      }),
    },
  };

  const prisma = {
    deliveryHandover: {
      findUnique: jest.fn(({ where }: Row) =>
        Promise.resolve(handovers[where.deliveryId] ?? null),
      ),
      updateMany: jest.fn(),
      findUniqueOrThrow: jest.fn(),
    },
    delivery: {
      findUnique: jest.fn(() => Promise.resolve(deliveryWithRelations())),
      create: jest.fn(),
      update: jest.fn(({ data }: Row) => {
        Object.assign(delivery, data);
        return Promise.resolve(delivery);
      }),
    },
    deliveryLocation: {
      create: jest.fn(({ data }: Row) => {
        positions.push(data);
        return Promise.resolve(data);
      }),
    },
    order: {
      findUnique: jest.fn(() =>
        Promise.resolve({
          ...order,
          restaurant: { nom: 'Chez Awa', owner: { firebaseUid: OWNER_UID } },
        }),
      ),
    },
    user: {
      findUnique: jest.fn(({ where }: Row) => {
        const found = where.firebaseUid
          ? Object.values(users).find(
              (u) => u.firebaseUid === where.firebaseUid,
            )
          : users[where.id];
        return Promise.resolve(found ?? null);
      }),
    },
    $transaction: jest.fn((fn: unknown) => {
      // `updateLocation` passe un TABLEAU d'opérations, les autres chemins une
      // fonction. Les deux formes doivent être servies.
      if (Array.isArray(fn)) return Promise.all(fn);
      // Sérialisées, comme PostgreSQL sérialise deux écritures concurrentes
      // sur la même ligne. Sans cette file, deux transactions imbriquées
      // prendraient leur instantané avant que l'autre n'écrive, et le rollback
      // de la perdante effacerait le travail de la gagnante — un artefact du
      // double, pas du code testé.
      return runSerialized(async () => {
        // Instantané pour le rollback : une exception doit tout annuler, sinon
        // le test croirait à une écriture partielle que PostgreSQL refuserait.
        const snapshot = {
          delivery: { ...delivery },
          order: { ...order },
          assignments: assignments.map((a) => ({ ...a })),
          users: JSON.parse(JSON.stringify(users)),
        };
        try {
          return await (fn as (t: unknown) => Promise<unknown>)(tx);
        } catch (err) {
          delivery = snapshot.delivery;
          order = snapshot.order;
          assignments = snapshot.assignments;
          users = snapshot.users;
          throw err;
        }
      });
    }),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    users = {
      'u-owner': {
        id: 'u-owner',
        firebaseUid: OWNER_UID,
        role: 'RESTAURATEUR',
      },
      'u-admin': { id: 'u-admin', firebaseUid: ADMIN_UID, role: 'ADMIN' },
      'liv-A': driver('liv-A'),
      'liv-B': driver('liv-B'),
    };
    order = {
      id: 'o1',
      userId: CLIENT_ID,
      restaurantId: 'r1',
      status: OrderStatus.PRET,
      isDelivery: true,
      isPreorder: false,
      scheduledFor: null,
      total: 6400,
      deliveryFeeGross: 1000,
    };
    delivery = {
      id: 'd1',
      orderId: 'o1',
      delivererId: null,
      status: DeliveryStatus.EN_ATTENTE,
      driverSettlementId: null,
      driverPayXaf: null,
      driverEconomicsFrozenAt: null,
    };
    assignments = [];
    handovers = {};
    positions = [];
    txQueue = Promise.resolve();
    emitter = { emit: jest.fn() };
    loyalty.awardForDeliveredOrder.mockResolvedValue(undefined);
    referral.rewardForDeliveredOrder.mockResolvedValue(undefined);
    trackingService.cacheLivePosition.mockResolvedValue(undefined);
    trackingService.forgetLastPosition.mockResolvedValue(undefined);
    trackingService.calculateETA.mockResolvedValue(12);

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
        DeliveryQueryService,
        DeliveryAssignmentService,
        DeliveryAssignmentLogService,
        OrderStateMachine,
        OrderTransitionService,
        { provide: PrismaService, useValue: prisma },
        { provide: EventEmitter2, useValue: emitter },
        { provide: NotificationsService, useValue: {} },
        { provide: TrackingGateway, useValue: trackingGateway },
        { provide: TrackingService, useValue: trackingService },
        {
          provide: PlatformSettingsService,
          useValue: {
            getSettings: jest.fn().mockResolvedValue({
              driverSharePercentLilia: 35,
              driverSharePercentIndependent: 65,
            }),
          },
        },
        { provide: LoyaltyService, useValue: loyalty },
        { provide: ReferralService, useValue: referral },
      ],
    }).compile();

    service = module.get(DeliveriesService);
  });

  // ── Raccourcis de scénario ────────────────────────────────────────────────

  const assign = (to: string, by = OWNER_UID) =>
    service.assignDeliverer('d1', to, by);
  const accept = (by: string) => service.acceptDelivery('d1', `fb-${by}`);
  const pickup = (by: string) => service.confirmPickup('d1', `fb-${by}`);
  const deliver = (by: string) =>
    service.updateStatus('d1', DeliveryStatus.LIVRER as any, `fb-${by}`);
  const fail = (by: string, reason?: string) =>
    service.updateStatus('d1', DeliveryStatus.ECHEC as any, `fb-${by}`, reason);

  const closedAssignments = () => assignments.filter((a) => a.releasedAt);

  // ═══════════════════════════════════════════════════════════════════════════
  // CAS 1 — le chemin nominal
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Cas 1 — PRET → A assigné → A livre → LIVRER', () => {
    it('la course va au bout et l’économie est gelée au nom de A', async () => {
      await assign('liv-A');
      await accept('liv-A');
      await pickup('liv-A');
      await deliver('liv-A');

      expect(delivery.status).toBe(DeliveryStatus.LIVRER);
      expect(order.status).toBe(OrderStatus.LIVRER);
      expect(delivery.delivererId).toBe('liv-A');
      // 35 % de 1 000 F de tarif brut.
      expect(delivery.driverPayXaf).toBe(350);
      expect(users['liv-A'].driverStatus).toBe(DriverStatus.AVAILABLE);
    });

    it('le journal désigne A comme celui qui a terminé', async () => {
      await assign('liv-A');
      await accept('liv-A');
      await pickup('liv-A');
      await deliver('liv-A');

      expect(assignments).toHaveLength(1);
      expect(assignments[0]).toMatchObject({
        delivererId: 'liv-A',
        assignedByRole: 'RESTAURATEUR',
        outcome: DeliveryAssignmentOutcome.COMPLETED,
      });
      expect(assignments[0].acceptedAt).toBeInstanceOf(Date);
      expect(assignments[0].pickedUpAt).toBeInstanceOf(Date);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // CAS 2 — réassignation avant récupération
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Cas 2 — A assigné → réassigné à B → B livre', () => {
    it('B mène la course à son terme', async () => {
      await assign('liv-A');
      await accept('liv-A');
      await assign('liv-B', ADMIN_UID);
      await accept('liv-B');
      await pickup('liv-B');
      await deliver('liv-B');

      expect(order.status).toBe(OrderStatus.LIVRER);
      expect(delivery.delivererId).toBe('liv-B');
    });

    /**
     * Le point qui n'avait AUCUNE réponse avant le journal : `Delivery` ne
     * porte que la main courante, donc A disparaissait sans trace au moment
     * précis où un litige aurait besoin de lui.
     */
    it('le journal garde les deux mains, dans l’ordre, avec leur issue', async () => {
      await assign('liv-A');
      await accept('liv-A');
      await assign('liv-B', ADMIN_UID);
      await accept('liv-B');
      await pickup('liv-B');
      await deliver('liv-B');

      expect(assignments).toHaveLength(2);
      expect(assignments[0]).toMatchObject({
        delivererId: 'liv-A',
        assignedByRole: 'RESTAURATEUR',
        outcome: DeliveryAssignmentOutcome.REASSIGNED,
      });
      expect(assignments[1]).toMatchObject({
        delivererId: 'liv-B',
        // Qui a réassigné : la question que personne ne pouvait poser.
        assignedByUserId: 'u-admin',
        assignedByRole: 'ADMIN',
        outcome: DeliveryAssignmentOutcome.COMPLETED,
      });
    });

    it('l’économie de A est effacée, celle de B est écrite', async () => {
      await assign('liv-A');
      await accept('liv-A');
      expect(delivery.driverPayXaf).toBe(350);

      await assign('liv-B', ADMIN_UID);
      // Entre les deux acceptations, la course n'appartient à personne : elle
      // ne doit donc rien à personne.
      expect(delivery.driverPayXaf).toBeNull();
      expect(delivery.driverEconomicsFrozenAt).toBeNull();

      await accept('liv-B');
      expect(delivery.driverPayXaf).toBe(350);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // CAS 2 bis — LE défaut : réassignation APRÈS récupération
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Cas 2 bis — A échoue en pleine course, B reprend', () => {
    /**
     * `confirmPickup` exigeait `PRET → EN_ROUTE`. Or l'échec en course ne
     * ramène PAS la commande à `PRET` — c'est délibéré, le vendeur arbitre.
     * B franchissait donc ASSIGNER puis ACCEPTER, et butait sur
     * « Transition invalide : EN_ROUTE → EN_ROUTE ». `LIVRER` n'étant
     * atteignable que depuis `EN_TRANSIT`, la commande devenait
     * **définitivement non livrable**.
     */
    it('B peut récupérer et livrer, alors que la commande est déjà EN_ROUTE', async () => {
      await assign('liv-A');
      await accept('liv-A');
      await pickup('liv-A');
      expect(order.status).toBe(OrderStatus.EN_ROUTE);

      await fail('liv-A', 'panne de moto');
      expect(delivery.status).toBe(DeliveryStatus.ECHEC);
      expect(delivery.delivererId).toBeNull();
      // L'échec n'annule pas la commande : elle reste EN_ROUTE.
      expect(order.status).toBe(OrderStatus.EN_ROUTE);

      await assign('liv-B');
      await accept('liv-B');
      await pickup('liv-B');

      expect(delivery.status).toBe(DeliveryStatus.EN_TRANSIT);
      await deliver('liv-B');
      expect(order.status).toBe(OrderStatus.LIVRER);
      expect(delivery.driverPayXaf).toBe(350);
    });

    it('la reprise ne renvoie PAS un second « votre commande est en route »', async () => {
      await assign('liv-A');
      await accept('liv-A');
      await pickup('liv-A');
      await fail('liv-A');
      emitter.emit.mockClear();

      await assign('liv-B');
      await accept('liv-B');
      await pickup('liv-B');

      const statusEvents = emitter.emit.mock.calls.filter(
        ([name]) => name === 'order.status.updated',
      );
      expect(statusEvents).toHaveLength(0);
      // Le vendeur, lui, est bien prévenu que le repas repart de chez lui.
      expect(emitter.emit).toHaveBeenCalledWith(
        'delivery.picked_up',
        expect.anything(),
      );
    });

    it('une commande annulée entre-temps bloque la reprise (409)', async () => {
      await assign('liv-A');
      await accept('liv-A');
      await pickup('liv-A');
      await fail('liv-A');
      await assign('liv-B');
      await accept('liv-B');

      order.status = OrderStatus.ANNULER;

      // La machine à états refuse `ANNULER → EN_ROUTE` avant même le verrou :
      // le refus est un 400, et c'est le bon — la commande n'existe plus.
      await expect(pickup('liv-B')).rejects.toBeInstanceOf(BadRequestException);
      // Rollback : la livraison n'a pas bougé non plus.
      expect(delivery.status).toBe(DeliveryStatus.ACCEPTER);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // CAS 3 et 7 — l'ancien livreur n'est plus personne
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Cas 3 & 7 — A réassigné tente encore d’agir', () => {
    beforeEach(async () => {
      await assign('liv-A');
      await accept('liv-A');
      await assign('liv-B', ADMIN_UID);
    });

    it('A ne peut plus accepter', async () => {
      await expect(accept('liv-A')).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('A ne peut plus récupérer le repas', async () => {
      await expect(pickup('liv-A')).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('A ne peut plus déclarer la course livrée', async () => {
      await expect(deliver('liv-A')).rejects.toBeInstanceOf(ForbiddenException);
      expect(order.status).toBe(OrderStatus.PRET);
    });

    it('A ne peut plus signaler un échec sur la course de B', async () => {
      await expect(fail('liv-A')).rejects.toBeInstanceOf(ForbiddenException);
      expect(delivery.status).toBe(DeliveryStatus.ASSIGNER);
      expect(delivery.delivererId).toBe('liv-B');
    });

    it('A ne peut plus publier sa position', async () => {
      await expect(
        service.updateLocation('d1', -4.26, 15.28, 10, 'fb-liv-A'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // CAS 4 — deux assignations simultanées
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Cas 4 — deux vendeurs assignent à la même seconde', () => {
    /**
     * L'écriture était un `update` inconditionnel et toutes les gardes sont
     * évaluées hors transaction : les deux requêtes lisaient
     * `delivererId = null`, passaient, et la dernière gagnait EN SILENCE. Les
     * DEUX livreurs recevaient « Nouvelle mission », et celui qui avait perdu
     * ne l'apprenait jamais — l'événement de l'autre annonçait
     * `previousDelivererId = null`, donc ne libérait personne.
     */
    it('une seule réussit, l’autre reçoit un 409', async () => {
      const [first, second] = await Promise.allSettled([
        assign('liv-A'),
        assign('liv-B', ADMIN_UID),
      ]);

      const outcomes = [first.status, second.status].sort();
      expect(outcomes).toEqual(['fulfilled', 'rejected']);

      const rejected = (
        first.status === 'rejected' ? first : second
      ) as PromiseRejectedResult;
      expect(rejected.reason).toBeInstanceOf(ConflictException);

      // Un seul titulaire, et un seul événement d'assignation.
      expect(assignments).toHaveLength(1);
      expect(assignments[0].delivererId).toBe(delivery.delivererId);
      expect(
        emitter.emit.mock.calls.filter(([n]) => n === 'delivery.assigned'),
      ).toHaveLength(1);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // CAS 5 — refus
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Cas 5 — A refuse, B prend la course', () => {
    it('la course redevient assignable et B la termine', async () => {
      await assign('liv-A');
      await service.declineDelivery('d1', 'fb-liv-A', 'trop loin');

      expect(delivery.status).toBe(DeliveryStatus.EN_ATTENTE);
      expect(delivery.delivererId).toBeNull();

      await assign('liv-B');
      await accept('liv-B');
      await pickup('liv-B');
      await deliver('liv-B');

      expect(order.status).toBe(OrderStatus.LIVRER);
    });

    it('le refus est tracé au nom de A, avec son motif', async () => {
      await assign('liv-A');
      await service.declineDelivery('d1', 'fb-liv-A', 'trop loin');

      expect(closedAssignments()).toHaveLength(1);
      expect(closedAssignments()[0]).toMatchObject({
        delivererId: 'liv-A',
        outcome: DeliveryAssignmentOutcome.DECLINED,
        releaseReason: 'trop loin',
      });
    });

    it('A ne peut pas refuser une mission qui vient de passer à B', async () => {
      await assign('liv-A');
      await assign('liv-B', ADMIN_UID);

      await expect(
        service.declineDelivery('d1', 'fb-liv-A', 'trop loin'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(delivery.delivererId).toBe('liv-B');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // CAS 6 — la position suit le livreur en titre
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Cas 6 — positions GPS de part et d’autre d’une réassignation', () => {
    it('A publie, puis ne publie plus ; B publie à son tour', async () => {
      await assign('liv-A');
      await accept('liv-A');
      await pickup('liv-A');

      // A est en course : sa position passe.
      await expect(
        service.updateLocation('d1', -4.26, 15.28, 8, 'fb-liv-A'),
      ).resolves.toBeDefined();

      await fail('liv-A');
      await assign('liv-B');
      await accept('liv-B');

      // B n'a pas encore le repas : la position est refusée (règle EN_TRANSIT
      // préexistante, inchangée).
      await expect(
        service.updateLocation('d1', -4.27, 15.29, 8, 'fb-liv-B'),
      ).rejects.toBeInstanceOf(BadRequestException);

      await pickup('liv-B');
      await expect(
        service.updateLocation('d1', -4.27, 15.29, 8, 'fb-liv-B'),
      ).resolves.toBeDefined();

      // Et A, lui, est définitivement muet sur cette course.
      await expect(
        service.updateLocation('d1', -4.26, 15.28, 8, 'fb-liv-A'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // CAS 8 — l'argent ne bouge qu'après une transition valide
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Cas 8 — fidélité et parrainage', () => {
    it('ne sont crédités qu’après le passage effectif à LIVRER', async () => {
      await assign('liv-A');
      await accept('liv-A');
      await pickup('liv-A');

      // Le vendeur annule pendant que le livreur roule : la clôture doit
      // échouer, et rien ne doit être crédité.
      order.status = OrderStatus.ANNULER;
      await expect(deliver('liv-A')).rejects.toBeTruthy();
      expect(delivery.status).toBe(DeliveryStatus.EN_TRANSIT);
      expect(loyalty.awardForDeliveredOrder).not.toHaveBeenCalled();
      expect(
        emitter.emit.mock.calls.filter(
          ([n, e]) => n === 'order.status.updated' && e?.newStatus === 'LIVRER',
        ),
      ).toHaveLength(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Tracking — la position ne survit pas à son propriétaire
  // ═══════════════════════════════════════════════════════════════════════════

  describe('position live à la réassignation', () => {
    /**
     * `delivery:{orderId}` a un TTL de 5 minutes. Sans purge, un client ouvrant
     * le suivi juste après une réassignation recevait, dès son `order:watch`,
     * la dernière position de l'ANCIEN livreur — figée, et indiscernable d'une
     * position vivante. Il la suivait.
     */
    it('la dernière position connue est oubliée', async () => {
      await assign('liv-A');
      await accept('liv-A');
      trackingService.forgetLastPosition.mockClear();

      await assign('liv-B', ADMIN_UID);

      expect(trackingService.forgetLastPosition).toHaveBeenCalledWith('o1');
    });

    /// Une panne Redis ne doit pas défaire une réassignation : c'est un geste
    /// d'exploitation, et le pire cas est le comportement d'avant.
    it('une purge en échec n\u2019empêche pas la réassignation', async () => {
      await assign('liv-A');
      trackingService.forgetLastPosition.mockRejectedValueOnce(
        new Error('redis down'),
      );

      await expect(assign('liv-B', ADMIN_UID)).resolves.toBeDefined();
      expect(delivery.delivererId).toBe('liv-B');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Terrain : ce qu'on ne réassigne plus
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Garde-fous de terrain', () => {
    /**
     * `PATCH /deliveries/:id/assign` ne consultait pas le statut de la
     * commande — seul `by-order/:orderId/assign` le faisait. On pouvait donc
     * réassigner une course DÉJÀ LIVRÉE par l'autre porte : l'économie du
     * livreur qui l'avait terminée était effacée (`CLEARED_DRIVER_ECONOMICS`)
     * et sa course attribuée à quelqu'un d'autre. Le montant dû disparaissait
     * du registre, `payableWhere` exigeant `driverEconomicsFrozenAt`.
     */
    it('une course livrée ne change plus de livreur', async () => {
      await assign('liv-A');
      await accept('liv-A');
      await pickup('liv-A');
      await deliver('liv-A');

      await expect(assign('liv-B', ADMIN_UID)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(delivery.delivererId).toBe('liv-A');
      expect(delivery.driverPayXaf).toBe(350);
    });

    it('une course déjà réglée ne change plus de livreur', async () => {
      await assign('liv-A');
      await accept('liv-A');
      delivery.driverSettlementId = 'stl-1';

      await expect(assign('liv-B', ADMIN_UID)).rejects.toThrow('règlement');
      expect(delivery.delivererId).toBe('liv-A');
    });

    it('une commande annulée n’accepte plus de livreur', async () => {
      order.status = OrderStatus.ANNULER;
      await expect(assign('liv-A')).rejects.toBeInstanceOf(BadRequestException);
      expect(assignments).toHaveLength(0);
    });
  });
});
