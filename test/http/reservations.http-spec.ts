import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import Redis from 'ioredis';

import { ReservationLifecycleService } from '../../apps/lilia-app/src/modules/reservations/reservation-lifecycle.service';
import {
  assertLocalTargets,
  DATABASE_URL,
  HttpHarness,
  idempotencyKey,
  REDIS_URL,
  startHttpHarness,
} from './harness';

/**
 * **Lot 4 (4B-2, J7) — réservations payées, de bout en bout par HTTP.**
 *
 * Application Nest réelle, PostgreSQL et Redis locaux jetables ; seules la
 * vérification du jeton Firebase et l'API pawaPay sont doublées (voir
 * `harness.ts`). Les callbacks pawaPay sont signés et vérifiés par le code
 * réel.
 *
 * Ce qui est posé en base, faute de route qui le produise :
 *  · la configuration de départ (réglage plateforme, restaurant Premium
 *    activé, tables et créneaux, comptes) — elle relève du back-office ;
 *  · l'horloge : une arrivée passée (absence, annulation tardive) se fait en
 *    reculant les heures de la réservation, et la clôture de l'absence à 12 h
 *    appelle le service planifié avec une date future. C'est écrit à chaque
 *    endroit.
 */
const describeIfStack = DATABASE_URL && REDIS_URL ? describe : describe.skip;

const MIN = 60_000;
const HOUR = 60 * MIN;
const ALL_DAYS = [
  'LUNDI',
  'MARDI',
  'MERCREDI',
  'JEUDI',
  'VENDREDI',
  'SAMEDI',
  'DIMANCHE',
] as const;

const OWNER = 'http-owner';
const VENDOR = 'http-vendor';
const CLIENT_1 = 'http-client-1';
const CLIENT_2 = 'http-client-2';
const ADMIN_1 = 'http-admin-1';
const ADMIN_2 = 'http-admin-2';
const SUPPORT = 'http-support';

describeIfStack('Réservations payées — parcours HTTP (J7)', () => {
  let h: HttpHarness;
  let prisma: PrismaClient;

  beforeAll(async () => {
    assertLocalTargets(); // avant tout FLUSHDB ou TRUNCATE
    const redis = new Redis(REDIS_URL!);
    await redis.flushdb();
    await redis.quit();
    prisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: DATABASE_URL }),
    });
    await prisma.$connect();
    h = await startHttpHarness();
  }, 120_000);

  afterAll(async () => {
    await h?.close();
    await prisma?.$disconnect();
  });

  beforeEach(async () => {
    h.pawapay.reset();
    const redis = new Redis(REDIS_URL!);
    await redis.flushdb(); // compteurs du throttler, cache des utilisateurs
    await redis.quit();
    await prisma.$executeRawUnsafe(`
      TRUNCATE TABLE "User", "Restaurant", "PlatformSettings",
        "FinancialApproval", "OutboxEvent", "PaymentEvent", "LedgerEntry",
        "LedgerTransaction", "Incident", "AdminAuditLog"
      RESTART IDENTITY CASCADE
    `);
    await seed();
  });

  // ─── Configuration de départ (back-office) ────────────────────────────────

  async function seed() {
    const allCaps = [
      'FINANCE_EXECUTE',
      'FINANCE_APPROVE',
      'USER_ROLES',
      'SETTINGS',
      'SUPPORT',
    ] as const;
    await prisma.user.createMany({
      data: [
        {
          id: OWNER,
          firebaseUid: OWNER,
          email: 'o@http.local',
          role: 'RESTAURATEUR',
        },
        {
          id: CLIENT_1,
          firebaseUid: CLIENT_1,
          email: 'c1@http.local',
          phone: '061234561',
        },
        {
          id: CLIENT_2,
          firebaseUid: CLIENT_2,
          email: 'c2@http.local',
          phone: '061234562',
        },
        {
          id: ADMIN_1,
          firebaseUid: ADMIN_1,
          email: 'a1@http.local',
          role: 'ADMIN',
          adminCapabilities: [...allCaps],
        },
        {
          id: ADMIN_2,
          firebaseUid: ADMIN_2,
          email: 'a2@http.local',
          role: 'ADMIN',
          adminCapabilities: [...allCaps],
        },
        {
          id: SUPPORT,
          firebaseUid: SUPPORT,
          email: 's@http.local',
          role: 'ADMIN',
          adminCapabilities: ['SUPPORT'],
        },
      ],
    });
    await prisma.platformSettings.create({
      data: { id: 'singleton', reservationsEnabled: true },
    });
    await prisma.restaurant.create({
      data: {
        id: VENDOR,
        nom: 'Le Comptoir HTTP',
        adresse: 'Poto-Poto',
        phone: '060000099',
        ownerId: OWNER,
        vendorType: 'RESTAURANT',
        onboardingStatus: 'ACTIVATED',
        adminApproved: true,
        isActive: true,
        payoutPhoneNumber: '242060000099',
        payoutProvider: 'MTN_MOMO',
        payoutVerifiedAt: new Date(Date.now() - 48 * HOUR),
      },
    });
    await prisma.operatingHours.createMany({
      data: ALL_DAYS.map((dayOfWeek) => ({
        restaurantId: VENDOR,
        dayOfWeek,
        openTime: '00:00',
        closeTime: '23:59',
      })),
    });
    await prisma.product.create({
      data: {
        id: 'http-poulet',
        nom: 'Poulet DG',
        prixOriginal: 5000,
        restaurantId: VENDOR,
        variants: {
          create: { id: 'http-poulet-v', prix: 5000, label: 'Normal' },
        },
      },
    });
    await prisma.reservationSettings.create({
      data: { restaurantId: VENDOR, enabled: true, updatedById: OWNER },
    });
    await prisma.reservationWindow.createMany({
      data: ALL_DAYS.map((dayOfWeek) => ({
        restaurantId: VENDOR,
        dayOfWeek,
        startTime: '11:00',
        endTime: '15:00',
      })),
    });
    // Une seule table : la dernière place se dispute.
    await prisma.reservationSpace.create({
      data: {
        id: 'http-table-1',
        restaurantId: VENDOR,
        kind: 'TABLE',
        label: 'Table 1',
        labelKey: 'table 1',
        minGuests: 1,
        maxGuests: 4,
      },
    });
    await prisma.vendorSubscription.create({
      data: {
        restaurantId: VENDOR,
        plan: 'PREMIUM',
        status: 'ACTIVE',
        startsAt: new Date(Date.now() - 24 * HOUR),
        endsAt: new Date(Date.now() + 29 * 24 * HOUR),
        priceXaf: 15000,
        paymentMethod: 'CASH',
        requestKey: `http-premium-${Date.now()}`,
        grantedById: ADMIN_1,
      },
    });
  }

  // ─── Outils (tout passe par l'API) ────────────────────────────────────────

  const data = <T = Record<string, unknown>>(res: { body: unknown }) =>
    (res.body as { data: T }).data;

  /**
   * 4C/4D — `HTTP_DUMP_DIR=<dossier>` enregistre les réponses réelles du
   * parcours complet : les tests de contrat des apps les lisent comme
   * fixtures, au lieu de JSON écrits à la main.
   */
  function dump<T extends { body: unknown }>(name: string, res: T): T {
    const dir = process.env.HTTP_DUMP_DIR;
    if (dir) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, `${name}.json`),
        `${JSON.stringify(res.body, null, 2)}\n`,
      );
    }
    return res;
  }

  /** Premier créneau libre, à partir du premier jour réservable. */
  async function firstSlot(): Promise<{ date: string; time: string }> {
    const bounds = data<{ firstDate: string; lastDate: string }>(
      await h
        .http()
        .get(`/vendors/${VENDOR}/reservation-availability`)
        .expect(200),
    );
    let date = bounds.firstDate;
    for (let i = 0; i < 4 && date <= bounds.lastDate; i++) {
      const day = data<{ slots: { time: string }[] }>(
        await h
          .http()
          .get(`/vendors/${VENDOR}/reservation-availability`)
          .query({ date, partySize: 2 })
          .expect(200),
      );
      if (day.slots.length > 0) {
        dump(
          'client_availability_slots',
          await h
            .http()
            .get(`/vendors/${VENDOR}/reservation-availability`)
            .query({ date, partySize: 2 })
            .expect(200),
        );
        return { date, time: day.slots[0].time };
      }
      const next = new Date(`${date}T12:00:00Z`);
      next.setUTCDate(next.getUTCDate() + 1);
      date = next.toISOString().slice(0, 10);
    }
    throw new Error('aucun créneau libre dans les 4 premiers jours');
  }

  async function fillCart(client: string) {
    await h
      .http(client)
      .post('/cart/add')
      .send({ variantId: 'http-poulet-v', quantite: 2 })
      .expect((r) => expect([200, 201]).toContain(r.status));
  }

  async function book(client: string, slot: { date: string; time: string }) {
    await fillCart(client);
    return h
      .http(client)
      .post('/reservations')
      .set('Idempotency-Key', idempotencyKey())
      .send({
        restaurantId: VENDOR,
        date: slot.date,
        time: slot.time,
        partySize: 2,
      });
  }

  const reservationOf = async (client: string, id: string) =>
    data<Record<string, unknown> & { status: string; orderId?: string }>(
      await h.http(client).get(`/reservations/${id}`).expect(200),
    );

  async function bookedAndAccepted(client = CLIENT_1) {
    const slot = await firstSlot();
    const created = await book(client, slot);
    expect(created.status).toBe(201);
    const id = data<{ id: string }>(created).id;
    await h
      .http(OWNER)
      .post(`/vendors/me/reservations/${id}/accept`)
      .expect(200);
    return id;
  }

  /** Total à payer, lu dans la vue client (jamais calculé par le test). */
  async function amountDue(client: string, id: string): Promise<number> {
    const r = await reservationOf(client, id);
    const total = (r.payment as { total?: number } | null)?.total;
    expect(typeof total).toBe('number');
    return total!;
  }

  async function pay(client: string, id: string) {
    const expectedTotal = await amountDue(client, id);
    await h
      .http(client)
      .post(`/reservations/${id}/pay`)
      .set('X-Lilia-Payment-Flow', 'provider')
      .send({ expectedTotal, phoneNumber: '061234561', method: 'MTN_MOMO' })
      .expect((r) => expect([200, 201]).toContain(r.status));
    const [deposit] = h.pawapay.posted('/v2/deposits').slice(-1);
    expect(deposit).toBeDefined();
    return { expectedTotal, depositId: String(deposit.depositId) };
  }

  const completedDeposit = (depositId: string, amountXaf: number) => ({
    depositId,
    status: 'COMPLETED',
    amount: String(amountXaf),
    requestedAmount: String(amountXaf),
    currency: 'XAF',
    country: 'COG',
    providerTransactionId: `mtn-${depositId.slice(0, 8)}`,
  });

  async function paidAndConfirmed(client = CLIENT_1) {
    const id = await bookedAndAccepted(client);
    const { expectedTotal, depositId } = await pay(client, id);
    await h
      .callback('deposits', completedDeposit(depositId, expectedTotal))
      .expect(200);
    expect((await reservationOf(client, id)).status).toBe('CONFIRMED');
    return { id, expectedTotal };
  }

  /**
   * Le worker dépile l'outbox. Horloge (posée en base) : les événements en
   * attente vieillissent au-delà de la grâce de 60 s du dépileur.
   */
  async function workerPass() {
    await prisma.outboxEvent.updateMany({
      where: { status: 'PENDING' },
      data: { createdAt: new Date(Date.now() - 61_000) },
    });
    await h.runOutbox();
  }

  const linkedOrder = (reservationId: string) =>
    prisma.order.findUniqueOrThrow({ where: { reservationId } });

  /**
   * Horloge (posée en base) : l'arrivée passe à `now + offset`, toutes les
   * échéances reculent du même écart (les CHECK d'ordre restent vrais).
   */
  async function shiftArrival(reservationId: string, offsetMs: number) {
    const r = await prisma.reservation.findUniqueOrThrow({
      where: { id: reservationId },
    });
    const delta = Date.now() + offsetMs - r.arrivalAt.getTime();
    const by = (d: Date | null) => (d ? new Date(d.getTime() + delta) : d);
    await prisma.reservation.update({
      where: { id: reservationId },
      data: {
        arrivalAt: by(r.arrivalAt)!,
        endsAt: by(r.endsAt)!,
        occupiedUntil: by(r.occupiedUntil)!,
        responseDeadlineAt: by(r.responseDeadlineAt)!,
        paymentDeadlineAt: by(r.paymentDeadlineAt),
      },
    });
  }

  // ─── Parcours nominal ─────────────────────────────────────────────────────

  it('demande → acceptation → paiement → callback signé → confirmée → code → honorée', async () => {
    const slot = await firstSlot();
    const key = idempotencyKey();
    await fillCart(CLIENT_1);
    const send = () =>
      h.http(CLIENT_1).post('/reservations').set('Idempotency-Key', key).send({
        restaurantId: VENDOR,
        date: slot.date,
        time: slot.time,
        partySize: 2,
      });
    const created = dump('client_create_pending', await send());
    expect(created.status).toBe(201);
    const id = data<{ id: string; status: string }>(created).id;
    dump(
      'vendor_list_pending',
      await h
        .http(OWNER)
        .get(`/vendors/me/reservations?date=${slot.date}`)
        .expect(200),
    );
    dump(
      'client_vendor_detail_reservable',
      await h.http().get(`/vendors/${VENDOR}`).expect(200),
    );
    dump(
      'client_availability_bounds',
      await h
        .http(CLIENT_1)
        .get(`/vendors/${VENDOR}/reservation-availability`)
        .expect(200),
    );
    expect(data<{ status: string }>(created).status).toBe('PENDING');
    // Même clé rejouée (après la fenêtre du limiteur, 1 demande par seconde
    // et par client) : la même réservation, rien de plus.
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const replay = await send();
    expect(data<{ id: string }>(replay).id).toBe(id);
    expect(await prisma.reservation.count()).toBe(1);

    // Payer avant l'acceptation : refusé.
    await h
      .http(CLIENT_1)
      .post(`/reservations/${id}/pay`)
      .set('X-Lilia-Payment-Flow', 'provider')
      .send({
        expectedTotal: 10_000,
        phoneNumber: '061234561',
        method: 'MTN_MOMO',
      })
      .expect(409);

    dump(
      'vendor_accept',
      await h
        .http(OWNER)
        .post(`/vendors/me/reservations/${id}/accept`)
        .expect(200),
    );
    expect((await reservationOf(CLIENT_1, id)).status).toBe('AWAITING_PAYMENT');
    dump(
      'client_get_awaiting_payment',
      await h.http(CLIENT_1).get(`/reservations/${id}`).expect(200),
    );

    // Fenêtre du limiteur de la route de paiement (tentative refusée juste avant).
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const { expectedTotal, depositId } = await pay(CLIENT_1, id);
    // La demande partie chez pawaPay porte le montant serveur.
    expect(h.pawapay.posted('/v2/deposits')[0]).toMatchObject({
      depositId,
      currency: 'XAF',
    });

    // Un callback non signé est refusé ; rien ne change.
    await h
      .http()
      .post('/webhooks/pawapay/deposits')
      .send(completedDeposit(depositId, expectedTotal))
      .expect(401);
    expect((await reservationOf(CLIENT_1, id)).status).toBe('AWAITING_PAYMENT');

    // Le callback signé confirme ; rejoué, il ne fait rien de plus.
    await h
      .callback('deposits', completedDeposit(depositId, expectedTotal))
      .expect(200);
    await h
      .callback('deposits', completedDeposit(depositId, expectedTotal))
      .expect(200);
    expect((await reservationOf(CLIENT_1, id)).status).toBe('CONFIRMED');
    expect(await prisma.payment.count({ where: { status: 'SUCCESS' } })).toBe(
      1,
    );
    dump(
      'vendor_get_confirmed',
      await h.http(OWNER).get(`/vendors/me/reservations/${id}`).expect(200),
    );
    dump(
      'client_list_me_confirmed',
      await h.http(CLIENT_1).get('/reservations/me').expect(200),
    );

    // 4C-0 (F-1) — sur la commande liée, aucun geste que la garde de
    // réservation refuserait en 409, ni pour le restaurant ni pour le client.
    const order = await linkedOrder(id);
    // Le restaurant lit sa commande par `/orders/restaurant/:id`, le client
    // par `/orders/:id`.
    const actionsOf = async (uid: string) =>
      data<{ allowedActions: string[] }>(
        await h
          .http(uid)
          .get(
            uid === OWNER
              ? `/orders/restaurant/${order.id}`
              : `/orders/${order.id}`,
          )
          .expect(200),
      ).allowedActions;
    expect(await actionsOf(OWNER)).toEqual(['START_PREPARATION']);
    expect(await actionsOf(CLIENT_1)).toEqual([]);

    // Le restaurant prépare, le client montre son code, le vendeur le saisit.
    for (const status of ['EN_PREPARATION', 'PRET']) {
      await h
        .http(OWNER)
        .patch(`/orders/${order.id}/status`)
        .send({ status })
        .expect(200);
    }
    const code = data<{ pickupCode: string }>(
      dump(
        'client_linked_order_ready',
        await h.http(CLIENT_1).get(`/orders/${order.id}`).expect(200),
      ),
    ).pickupCode;
    expect(code).toMatch(/^\d{4}$/);
    expect(await actionsOf(OWNER)).toEqual(['HAND_OVER']);
    expect(await actionsOf(CLIENT_1)).toEqual([]);
    await h
      .http(OWNER)
      .post(`/orders/${order.id}/pickup/handover`)
      .send({ code })
      .expect(200);

    expect((await reservationOf(CLIENT_1, id)).status).toBe('HONORED');
    expect((await linkedOrder(id)).status).toBe('LIVRER');
    dump(
      'vendor_get_honored',
      await h.http(OWNER).get(`/vendors/me/reservations/${id}`).expect(200),
    );
    dump(
      'client_get_honored',
      await h.http(CLIENT_1).get(`/reservations/${id}`).expect(200),
    );
  });

  it('4C-0 (D-1) — la fiche publique dit que le restaurant réserve', async () => {
    const vendor = await h.http().get(`/vendors/${VENDOR}`).expect(200);
    expect(data<{ reservable: boolean }>(vendor).reservable).toBe(true);
    await prisma.reservationSettings.update({
      where: { restaurantId: VENDOR },
      data: { enabled: false },
    });
    const off = await h.http().get(`/vendors/${VENDOR}`).expect(200);
    expect(data<{ reservable: boolean }>(off).reservable).toBe(false);
    await prisma.reservationSettings.update({
      where: { restaurantId: VENDOR },
      data: { enabled: true },
    });
  });

  it('payer avec un montant périmé : 409, rien ne part chez pawaPay', async () => {
    const id = await bookedAndAccepted();
    const due = await amountDue(CLIENT_1, id);
    await h
      .http(CLIENT_1)
      .post(`/reservations/${id}/pay`)
      .set('X-Lilia-Payment-Flow', 'provider')
      .send({
        expectedTotal: due - 1,
        phoneNumber: '061234561',
        method: 'MTN_MOMO',
      })
      .expect(409);
    expect(h.pawapay.posted('/v2/deposits')).toEqual([]);
  });

  it('un paiement échoué laisse la réservation en attente de paiement', async () => {
    const id = await bookedAndAccepted();
    const { expectedTotal, depositId } = await pay(CLIENT_1, id);
    await h
      .callback('deposits', {
        ...completedDeposit(depositId, expectedTotal),
        status: 'FAILED',
        failureReason: {
          failureCode: 'PAYER_LIMIT_REACHED',
          failureMessage: 'Plafond',
        },
      })
      .expect(200);
    expect((await reservationOf(CLIENT_1, id)).status).toBe('AWAITING_PAYMENT');
    expect(await prisma.payment.count({ where: { status: 'SUCCESS' } })).toBe(
      0,
    );
  });

  it('callback de paiement perdu : la réconciliation confirme la réservation', async () => {
    const id = await bookedAndAccepted();
    const { expectedTotal, depositId } = await pay(CLIENT_1, id);
    // Le prestataire connaît l'encaissement abouti ; aucun callback n'arrive.
    h.pawapay.know(depositId, completedDeposit(depositId, expectedTotal));
    // Horloge : la grâce de 180 s du cron est passée.
    await prisma.payment.updateMany({
      data: { createdAt: new Date(Date.now() - 4 * MIN) },
    });
    await h.reconcilePayments();
    expect((await reservationOf(CLIENT_1, id)).status).toBe('CONFIRMED');
    expect(await prisma.payment.count({ where: { status: 'SUCCESS' } })).toBe(
      1,
    );
  });

  // ─── Refus, expiration, annulations ───────────────────────────────────────

  it('refus du restaurant : aucune commande, aucun paiement', async () => {
    const slot = await firstSlot();
    const id = data<{ id: string }>(await book(CLIENT_1, slot)).id;
    await h
      .http(OWNER)
      .post(`/vendors/me/reservations/${id}/decline`)
      .send({ reason: 'FULLY_BOOKED' })
      .expect(200);
    expect((await reservationOf(CLIENT_1, id)).status).toBe('DECLINED');
    expect(await prisma.order.count()).toBe(0);
    expect(await prisma.payment.count()).toBe(0);
  });

  it('acceptée mais jamais payée : expirée par le service planifié, commande liée annulée', async () => {
    const id = await bookedAndAccepted();
    // Horloge : le service planifié tourne « une heure plus tard ».
    await h.app
      .get(ReservationLifecycleService)
      .expireOverdue(new Date(Date.now() + HOUR));
    expect((await reservationOf(CLIENT_1, id)).status).toBe('EXPIRED');
    expect((await linkedOrder(id)).status).toBe('ANNULER');
  });

  it('annulation à temps d’une réservation payée : remboursement intégral ouvert', async () => {
    const { id, expectedTotal } = await paidAndConfirmed();
    await h
      .http(CLIENT_1)
      .post(`/reservations/${id}/cancel`)
      .send({})
      .expect(200);
    const r = await prisma.reservation.findUniqueOrThrow({ where: { id } });
    expect(r).toMatchObject({
      status: 'CANCELLED_BY_CLIENT',
      lateCancellation: false,
    });
    // Le remboursement est ouvert par l'effet `order.refund_due` (outbox).
    await workerPass();
    const refund = await prisma.refund.findFirstOrThrow({
      where: { orderId: (await linkedOrder(id)).id },
    });
    expect(refund).toMatchObject({ status: 'PENDING', amount: expectedTotal });
  });

  it('annulation tardive (< 120 min) : marquée tardive, remboursée en V1', async () => {
    const { id, expectedTotal } = await paidAndConfirmed();
    // Horloge : l'arrivée est dans 60 minutes.
    await shiftArrival(id, 60 * MIN);
    await h
      .http(CLIENT_1)
      .post(`/reservations/${id}/cancel`)
      .send({})
      .expect(200);
    const r = await prisma.reservation.findUniqueOrThrow({ where: { id } });
    expect(r).toMatchObject({
      status: 'CANCELLED_BY_CLIENT',
      lateCancellation: true,
    });
    await workerPass();
    const refund = await prisma.refund.findFirstOrThrow({
      where: { orderId: (await linkedOrder(id)).id },
    });
    expect(refund.amount).toBe(expectedTotal);
  });

  // ─── Concurrence ──────────────────────────────────────────────────────────

  it('deux clients visent la dernière table en même temps : une seule demande passe', async () => {
    const slot = await firstSlot();
    await fillCart(CLIENT_1);
    await fillCart(CLIENT_2);
    const attempt = (client: string) =>
      h
        .http(client)
        .post('/reservations')
        .set('Idempotency-Key', idempotencyKey())
        .send({
          restaurantId: VENDOR,
          date: slot.date,
          time: slot.time,
          partySize: 2,
        });
    const results = await Promise.all([attempt(CLIENT_1), attempt(CLIENT_2)]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await prisma.reservation.count()).toBe(1);
  });

  // ─── Absence et versement de la part restaurant (J6, J6b) ─────────────────

  /** Réservation payée, absence déclarée, clôturée 12 h après. */
  async function settledNoShow() {
    const { id, expectedTotal } = await paidAndConfirmed();
    // Horloge : le client était attendu il y a 20 minutes.
    await shiftArrival(id, -20 * MIN);
    await h
      .http(OWNER)
      .post(`/vendors/me/reservations/${id}/no-show`)
      .expect(200);
    // Horloge : le service planifié clôt l'absence 12 h plus tard.
    await h.app
      .get(ReservationLifecycleService)
      .settleNoShows(new Date(Date.now() + 12 * HOUR + MIN));
    const settlement =
      await prisma.reservationNoShowSettlement.findUniqueOrThrow({
        where: { reservationId: id },
      });
    expect(settlement.totalXaf).toBe(expectedTotal);
    expect(settlement.vendorShareXaf).toBeGreaterThan(0);
    return settlement;
  }

  /** Demande (admin 1) puis validation (admin 2) : rend le virement envoyé. */
  async function payoutApprovedByTwo(settlementId: string) {
    const requested = await h
      .http(ADMIN_1)
      .post(`/admin/reservation-no-shows/${settlementId}/payout`)
      .expect(202);
    const approvalId = data<{ approval: { id: string } }>(requested).approval
      .id;
    await h
      .http(ADMIN_2)
      .post(`/admin/approvals/${approvalId}/approve`)
      .expect(200);
    const [sent] = h.pawapay.posted('/v2/payouts');
    return sent;
  }

  it('callback de versement perdu : la réconciliation solde la part d’absence', async () => {
    const settlement = await settledNoShow();
    const sent = await payoutApprovedByTwo(settlement.id);
    const payoutId = String(sent.payoutId);
    // Le prestataire connaît le virement abouti ; aucun callback n'arrive.
    h.pawapay.know(payoutId, {
      payoutId,
      status: 'COMPLETED',
      amount: String(settlement.vendorShareXaf),
      requestedAmount: String(settlement.vendorShareXaf),
      currency: 'XAF',
      country: 'COG',
      providerTransactionId: 'mtn-payout-reconciled',
    });
    // Horloge : la grâce de 180 s du cron est passée.
    await prisma.reservationNoShowPayout.updateMany({
      data: { updatedAt: new Date(Date.now() - 4 * MIN) },
    });
    await h.reconcilePayments();
    const [payout] = await prisma.reservationNoShowPayout.findMany();
    expect(payout).toMatchObject({
      status: 'SUCCESS',
      providerTransactionId: 'mtn-payout-reconciled',
    });
  });

  it('absence → clôture à 12 h → part restaurant versée à deux administrateurs, callback signé', async () => {
    const settlement = await settledNoShow();

    const list = (admin: string, state?: string) =>
      h
        .http(admin)
        .get('/admin/reservation-no-shows')
        .query(state ? { state } : {});
    expect(
      data<{ payoutState: string }[]>(await list(SUPPORT).expect(200)).map(
        (s) => s.payoutState,
      ),
    ).toEqual(['DUE']);

    // Sans FINANCE_EXECUTE : refusé.
    await h
      .http(SUPPORT)
      .post(`/admin/reservation-no-shows/${settlement.id}/payout`)
      .expect(403);

    const requested = await h
      .http(ADMIN_1)
      .post(`/admin/reservation-no-shows/${settlement.id}/payout`)
      .expect(202);
    const approvalId = data<{ approval: { id: string } }>(requested).approval
      .id;
    expect(h.pawapay.posted('/v2/payouts')).toEqual([]);

    // Le demandeur ne valide pas.
    await h
      .http(ADMIN_1)
      .post(`/admin/approvals/${approvalId}/approve`)
      .expect(403);
    expect(h.pawapay.posted('/v2/payouts')).toEqual([]);

    // Le second administrateur valide : le virement part, vers le numéro figé.
    await h
      .http(ADMIN_2)
      .post(`/admin/approvals/${approvalId}/approve`)
      .expect(200);
    const [sent] = h.pawapay.posted('/v2/payouts');
    expect(sent).toMatchObject({
      amount: String(settlement.vendorShareXaf),
      currency: 'XAF',
    });
    expect(JSON.stringify(sent)).toContain('242060000099');
    // Rejoué : aucun second virement.
    await h
      .http(ADMIN_2)
      .post(`/admin/approvals/${approvalId}/approve`)
      .expect((r) => expect(r.status).toBe(409));
    expect(h.pawapay.posted('/v2/payouts')).toHaveLength(1);

    // Un montant annoncé différent ne solde rien.
    const payoutCallback = (amount: number) => ({
      payoutId: String(sent.payoutId),
      status: 'COMPLETED',
      amount: String(amount),
      requestedAmount: String(amount),
      currency: 'XAF',
      country: 'COG',
      providerTransactionId: 'mtn-payout-1',
    });
    await h
      .callback('payouts', payoutCallback(settlement.vendorShareXaf + 1))
      .expect(200);
    expect(
      data<{ payoutState: string }[]>(await list(SUPPORT).expect(200))[0]
        .payoutState,
    ).toBe('IN_PROGRESS');

    await h
      .callback('payouts', payoutCallback(settlement.vendorShareXaf))
      .expect(200);
    const [paid] = data<
      { payoutState: string; payouts: { maskedPhone: string }[] }[]
    >(await list(SUPPORT, 'PAID').expect(200));
    expect(paid.payoutState).toBe('PAID');
    // La liste ne renvoie jamais le numéro complet.
    expect(JSON.stringify(paid)).not.toContain('242060000099');

    // Une nouvelle demande est refusée : la part est versée.
    await h
      .http(ADMIN_1)
      .post(`/admin/reservation-no-shows/${settlement.id}/payout`)
      .expect(409);
  });
});
