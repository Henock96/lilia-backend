import { PrismaPg } from '@prisma/adapter-pg';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { OrderStatus, PrismaClient } from '@prisma/client';

import { HANDOVER_MAX_ATTEMPTS } from '../../apps/lilia-app/src/modules/deliveries/delivery-handover';
import { OrderLifecycleService } from '../../apps/lilia-app/src/modules/orders/order-lifecycle.service';
import { OrderStateMachine } from '../../apps/lilia-app/src/modules/orders/order-state.machine';
import { OrderTransitionService } from '../../apps/lilia-app/src/modules/orders/order-transition.service';
import { StockService } from '../../apps/lilia-app/src/modules/orders/stock.service';
import { OutboxService } from '../../apps/lilia-app/src/modules/outbox/outbox.service';

/**
 * **F3-07 — retrait au comptoir : la remise se prouve.**
 *
 * Contre un vrai PostgreSQL, parce que les garanties centrales sont des
 * garanties de base de données : les CHECK de la matrice d'invariants (I-1 à
 * I-8) et le verrou optimiste qui ne laisse passer qu'une confirmation. Les
 * numéros I-n renvoient à F3-07-PICKUP-CONFIRMATION-DISCOVERY.md (§16-17).
 */
const DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

describeIfDb('Retrait au comptoir — preuve de remise (PostgreSQL réel)', () => {
  let prisma: PrismaClient;
  let lifecycle: OrderLifecycleService;
  const events = new EventEmitter2();
  const emitted: string[] = [];

  const OWNER_UID = 'fb-pk-owner';
  const CLIENT_UID = 'fb-pk-client';
  const OTHER_UID = 'fb-pk-other';
  const ADMIN_UID = 'fb-pk-admin';
  const ORDER = 'pk-order';

  beforeAll(async () => {
    prisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: DATABASE_URL }),
    });
    await prisma.$connect();
    lifecycle = new OrderLifecycleService(
      prisma as never,
      events,
      new OrderStateMachine(),
      new OrderTransitionService(),
      new StockService(),
      { awardForDeliveredOrder: async () => 0 } as never,
      { rewardForDeliveredOrder: async () => undefined } as never,
      { openForCancelledOrder: async () => null } as never,
      { record: async () => undefined } as never,
      new OutboxService(prisma as never),
    );
    events.onAny((name) => emitted.push(String(name)));
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    emitted.length = 0;
    await prisma.$executeRawUnsafe(`
      TRUNCATE TABLE "PickupHandover", "OutboxEvent", "OrderItem",
                     "OrderHistory", "Order", "Restaurant", "User",
                     "PlatformSettings"
      RESTART IDENTITY CASCADE
    `);
    await prisma.user.createMany({
      data: [
        {
          id: 'pk-owner',
          firebaseUid: OWNER_UID,
          email: 'pk-o@test.local',
          role: 'RESTAURATEUR',
        },
        { id: 'pk-client', firebaseUid: CLIENT_UID, email: 'pk-c@test.local' },
        { id: 'pk-other', firebaseUid: OTHER_UID, email: 'pk-x@test.local' },
        {
          id: 'pk-admin',
          firebaseUid: ADMIN_UID,
          email: 'pk-a@test.local',
          role: 'ADMIN',
        },
      ],
    });
    await prisma.restaurant.create({
      data: {
        id: 'pk-vendor',
        nom: 'Chez Comptoir',
        adresse: 'Poto-Poto',
        phone: '060000050',
        ownerId: 'pk-owner',
      },
    });
    await createOrder(OrderStatus.EN_PREPARATION);
  });

  async function createOrder(
    status: OrderStatus,
    opts: { id?: string; isDelivery?: boolean } = {},
  ) {
    await prisma.order.create({
      data: {
        id: opts.id ?? ORDER,
        restaurantId: 'pk-vendor',
        userId: 'pk-client',
        subTotal: 4000,
        deliveryFee: 0,
        deliveryFeeGross: 0,
        total: 4000,
        paymentMethod: 'MTN_MOMO',
        isDelivery: opts.isDelivery ?? false,
        status,
      },
    });
  }

  /** Le vendeur passe la commande « prête » : le code de retrait naît. */
  const markReady = () =>
    lifecycle.updateOrderStatusByRestaurateur(ORDER, OWNER_UID, 'PRET');
  const readOrder = () =>
    prisma.order.findUniqueOrThrow({ where: { id: ORDER } });
  const livrerHistory = () =>
    prisma.orderHistory.count({
      where: { orderId: ORDER, toStatus: OrderStatus.LIVRER },
    });
  const deliveredOutbox = () =>
    prisma.outboxEvent.count({
      where: { aggregateId: ORDER, type: 'order.delivered' },
    });
  const minutesBetween = (a: Date, b: Date) =>
    Math.round((b.getTime() - a.getTime()) / 60_000);

  // ─── Confirmation du client ──────────────────────────────────────────────

  describe('le client confirme « J’ai récupéré ma commande »', () => {
    it('PRET → LIVRER, preuve client, échéance = confirmation + délai paramétré', async () => {
      await prisma.platformSettings.create({
        data: { id: 'singleton', vendorPayoutDelayMinutes: 90 },
      });
      await markReady();

      await expect(
        lifecycle.confirmPickupByCustomer(ORDER, CLIENT_UID),
      ).resolves.toEqual({ outcome: 'CONFIRMED' });

      const order = await readOrder();
      expect(order.status).toBe(OrderStatus.LIVRER);
      expect(order.deliveryProof).toBe('PICKUP_CUSTOMER_CONFIRMED');
      expect(order.customerConfirmedAt).toEqual(order.deliveredAt);
      expect(minutesBetween(order.deliveredAt!, order.payoutDueAt!)).toBe(90);
      const history = await prisma.orderHistory.findFirstOrThrow({
        where: { orderId: ORDER, toStatus: OrderStatus.LIVRER },
      });
      expect(history).toMatchObject({
        fromStatus: OrderStatus.PRET,
        actionId: 'CLIENT',
        actorUserId: 'pk-client',
        source: 'APP',
      });
      expect(await deliveredOutbox()).toBe(1);
      expect(emitted).toContain('order.status.updated');
    });

    it('sans ligne de réglages : délai par défaut de 60 min (D5)', async () => {
      await markReady();
      await lifecycle.confirmPickupByCustomer(ORDER, CLIENT_UID);
      const order = await readOrder();
      expect(minutesBetween(order.deliveredAt!, order.payoutDueAt!)).toBe(60);
    });

    it('I-10 — double confirmation : un seul effet, échéance inchangée', async () => {
      await markReady();
      await lifecycle.confirmPickupByCustomer(ORDER, CLIENT_UID);
      const first = await readOrder();

      await expect(
        lifecycle.confirmPickupByCustomer(ORDER, CLIENT_UID),
      ).resolves.toEqual({ outcome: 'ALREADY_PROVED' });

      const second = await readOrder();
      expect(second.payoutDueAt).toEqual(first.payoutDueAt);
      expect(second.customerConfirmedAt).toEqual(first.customerConfirmedAt);
      expect(await livrerHistory()).toBe(1);
      expect(await deliveredOutbox()).toBe(1);
    });

    it('deux confirmations simultanées : une seule transition', async () => {
      await markReady();
      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          lifecycle.confirmPickupByCustomer(ORDER, CLIENT_UID),
        ),
      );
      expect(results.filter((r) => r.outcome === 'CONFIRMED')).toHaveLength(1);
      expect(await livrerHistory()).toBe(1);
      expect(await deliveredOutbox()).toBe(1);
      expect((await readOrder()).deliveryProof).toBe(
        'PICKUP_CUSTOMER_CONFIRMED',
      );
    });

    it('I-12 — un autre client, le vendeur, l’admin : « introuvable », rien n’est écrit', async () => {
      await markReady();
      for (const uid of [OTHER_UID, OWNER_UID, ADMIN_UID, 'fb-inconnu']) {
        await expect(
          lifecycle.confirmPickupByCustomer(ORDER, uid),
        ).rejects.toMatchObject({ status: 404 });
      }
      const order = await readOrder();
      expect(order.status).toBe(OrderStatus.PRET);
      expect(order.deliveryProof).toBeNull();
    });

    it.each([
      [OrderStatus.EN_ATTENTE, 'PICKUP_NOT_READY'],
      [OrderStatus.PAYER, 'PICKUP_NOT_READY'],
      [OrderStatus.ACCEPTEE, 'PICKUP_NOT_READY'],
      [OrderStatus.EN_PREPARATION, 'PICKUP_NOT_READY'],
      [OrderStatus.ANNULER, 'ORDER_CLOSED'],
    ])('%s → 409 %s, rien n’est écrit', async (status, code) => {
      await prisma.order.update({ where: { id: ORDER }, data: { status } });
      await expect(
        lifecycle.confirmPickupByCustomer(ORDER, CLIENT_UID),
      ).rejects.toMatchObject({ status: 409, response: { code } });
      expect((await readOrder()).status).toBe(status);
    });

    it('une livraison à domicile : 409 PICKUP_NOT_APPLICABLE', async () => {
      await createOrder(OrderStatus.EN_ROUTE, {
        id: 'pk-delivery',
        isDelivery: true,
      });
      await expect(
        lifecycle.confirmPickupByCustomer('pk-delivery', CLIENT_UID),
      ).rejects.toMatchObject({
        status: 409,
        response: { code: 'PICKUP_NOT_APPLICABLE' },
      });
    });
  });

  // ─── Remise déclarée par le vendeur seul ─────────────────────────────────

  describe('le vendeur déclare la remise sans code (D-P1)', () => {
    it('LIVRER + PICKUP_VENDOR_DECLARED, sans échéance de versement', async () => {
      await markReady();
      await lifecycle.updateOrderStatusByRestaurateur(
        ORDER,
        OWNER_UID,
        'LIVRER',
      );
      const order = await readOrder();
      expect(order.status).toBe(OrderStatus.LIVRER);
      expect(order.deliveryProof).toBe('PICKUP_VENDOR_DECLARED');
      expect(order.payoutDueAt).toBeNull();
      expect(order.customerConfirmedAt).toBeNull();
    });

    it('I-9 — le client confirme ensuite : la preuve monte, sans nouvelle transition', async () => {
      await markReady();
      await lifecycle.updateOrderStatusByRestaurateur(
        ORDER,
        OWNER_UID,
        'LIVRER',
      );
      const declared = await readOrder();

      await expect(
        lifecycle.confirmPickupByCustomer(ORDER, CLIENT_UID),
      ).resolves.toEqual({ outcome: 'UPGRADED' });

      const order = await readOrder();
      expect(order.deliveryProof).toBe('PICKUP_CUSTOMER_CONFIRMED');
      expect(order.deliveredAt).toEqual(declared.deliveredAt);
      expect(order.payoutDueAt!.getTime()).toBe(
        order.customerConfirmedAt!.getTime() + 60 * 60_000,
      );
      expect(await livrerHistory()).toBe(1);
      expect(await deliveredOutbox()).toBe(1);
      expect(emitted).toContain('order.pickup.confirmed');
    });

    it('vendeur et client à la même seconde : la preuve finale est toujours celle du client', async () => {
      await markReady();
      const outcomes = await Promise.allSettled([
        lifecycle.updateOrderStatusByRestaurateur(ORDER, OWNER_UID, 'LIVRER'),
        lifecycle.confirmPickupByCustomer(ORDER, CLIENT_UID),
      ]);
      // Le client ne perd jamais : s'il arrive second, il monte la preuve.
      expect(outcomes[1].status).toBe('fulfilled');
      const order = await readOrder();
      expect(order.deliveryProof).toBe('PICKUP_CUSTOMER_CONFIRMED');
      expect(order.payoutDueAt).not.toBeNull();
      expect(await livrerHistory()).toBe(1);
    });
  });

  // ─── Clôture admin ───────────────────────────────────────────────────────

  it('D-P3 — l’admin clôture : PICKUP_ADMIN_OVERRIDE, jamais une confirmation client', async () => {
    await markReady();
    await lifecycle.updateOrderStatusByRestaurateur(ORDER, ADMIN_UID, 'LIVRER');
    const order = await readOrder();
    expect(order.deliveryProof).toBe('PICKUP_ADMIN_OVERRIDE');
    expect(order.customerConfirmedAt).toBeNull();
    expect(order.payoutDueAt).not.toBeNull();
    await expect(
      lifecycle.confirmPickupByCustomer(ORDER, CLIENT_UID),
    ).resolves.toEqual({ outcome: 'ALREADY_PROVED' });
  });

  // ─── Code au comptoir (D-P5) ─────────────────────────────────────────────

  describe('le vendeur saisit le code du client (D-P5)', () => {
    const code = async () =>
      (
        await prisma.pickupHandover.findUniqueOrThrow({
          where: { orderId: ORDER },
        })
      ).code;
    const wrong = (c: string) => (c === '0000' ? '1111' : '0000');

    it('I-21 — le code naît au passage à PRET, une seule fois', async () => {
      await markReady();
      const first = await code();
      expect(first).toMatch(/^\d{4}$/);
      // PRET ne se rejoue pas, mais un upsert ne doit jamais changer un code
      // déjà montré : on vérifie la règle en rejouant l'écriture.
      await prisma.pickupHandover.upsert({
        where: { orderId: ORDER },
        create: { orderId: ORDER, code: '9999' },
        update: {},
      });
      expect(await code()).toBe(first);
    });

    it('I-21 — pas de code pour une livraison', async () => {
      await createOrder(OrderStatus.EN_PREPARATION, {
        id: 'pk-delivery',
        isDelivery: true,
      });
      await lifecycle.updateOrderStatusByRestaurateur(
        'pk-delivery',
        OWNER_UID,
        'PRET',
      );
      expect(
        await prisma.pickupHandover.count({
          where: { orderId: 'pk-delivery' },
        }),
      ).toBe(0);
    });

    it('bon code : LIVRER + PICKUP_CODE, échéance posée', async () => {
      await markReady();
      await lifecycle.handOverPickupWithCode(ORDER, OWNER_UID, await code());
      const order = await readOrder();
      expect(order.deliveryProof).toBe('PICKUP_CODE');
      expect(order.payoutDueAt).not.toBeNull();
      const history = await prisma.orderHistory.findFirstOrThrow({
        where: { orderId: ORDER, toStatus: OrderStatus.LIVRER },
      });
      expect(history.actionId).toBe('RESTAURATEUR');
    });

    it('mauvais code : 400, la commande reste PRET', async () => {
      await markReady();
      await expect(
        lifecycle.handOverPickupWithCode(ORDER, OWNER_UID, wrong(await code())),
      ).rejects.toMatchObject({
        status: 400,
        response: { code: 'HANDOVER_CODE_INVALID' },
      });
      expect((await readOrder()).status).toBe(OrderStatus.PRET);
    });

    it('I-19 — une rafale de 10 saisies ne consomme que 5 essais, puis tout est bloqué', async () => {
      await markReady();
      const bad = wrong(await code());
      await Promise.allSettled(
        Array.from({ length: 10 }, () =>
          lifecycle.handOverPickupWithCode(ORDER, OWNER_UID, bad),
        ),
      );
      const record = await prisma.pickupHandover.findUniqueOrThrow({
        where: { orderId: ORDER },
      });
      expect(record.attempts).toBe(HANDOVER_MAX_ATTEMPTS);
      // Même le bon code ne passe plus : il reste la remise sans code.
      await expect(
        lifecycle.handOverPickupWithCode(ORDER, OWNER_UID, record.code),
      ).rejects.toMatchObject({
        status: 403,
        response: { code: 'HANDOVER_CODE_LOCKED' },
      });
    });

    it('l’admin ne saisit pas de code : sa clôture est un arbitrage', async () => {
      await markReady();
      await expect(
        lifecycle.handOverPickupWithCode(ORDER, ADMIN_UID, await code()),
      ).rejects.toMatchObject({ status: 403 });
      expect((await readOrder()).status).toBe(OrderStatus.PRET);
    });

    it('un autre vendeur ne peut pas remettre la commande', async () => {
      await markReady();
      await prisma.user.create({
        data: {
          id: 'pk-owner2',
          firebaseUid: 'fb-pk-owner2',
          email: 'pk-o2@test.local',
          role: 'RESTAURATEUR',
        },
      });
      await expect(
        lifecycle.handOverPickupWithCode(ORDER, 'fb-pk-owner2', await code()),
      ).rejects.toMatchObject({ status: 403 });
    });

    it('I-20 — pas de PICKUP_CODE sur une commande déjà remise', async () => {
      await markReady();
      const c = await code();
      await lifecycle.updateOrderStatusByRestaurateur(
        ORDER,
        OWNER_UID,
        'LIVRER',
      );
      await expect(
        lifecycle.handOverPickupWithCode(ORDER, OWNER_UID, c),
      ).rejects.toMatchObject({
        status: 409,
        response: { code: 'ORDER_ALREADY_HANDED_OVER' },
      });
      expect((await readOrder()).deliveryProof).toBe('PICKUP_VENDOR_DECLARED');
    });

    it('commande prête avant la mise en service (sans code) : 409 PICKUP_CODE_UNAVAILABLE', async () => {
      await prisma.order.update({
        where: { id: ORDER },
        data: { status: OrderStatus.PRET },
      });
      await expect(
        lifecycle.handOverPickupWithCode(ORDER, OWNER_UID, '1234'),
      ).rejects.toMatchObject({
        status: 409,
        response: { code: 'PICKUP_CODE_UNAVAILABLE' },
      });
    });
  });

  // ─── Matrice d'invariants : la base refuse, pas seulement le code ────────

  describe('CHECK en base (I-1 à I-8)', () => {
    const livre = { status: OrderStatus.LIVRER, deliveredAt: new Date() };
    const later = new Date(Date.now() + 3_600_000);

    it.each<[string, Record<string, unknown>]>([
      ['I-1 valeur inconnue', { ...livre, deliveryProof: 'PICKUP_SELFIE' }],
      [
        'I-2 preuve sur une commande non livrée',
        {
          status: OrderStatus.PRET,
          deliveredAt: new Date(),
          deliveryProof: 'PICKUP_VENDOR_DECLARED',
        },
      ],
      [
        'I-3 preuve sans date de remise',
        { status: OrderStatus.LIVRER, deliveryProof: 'PICKUP_VENDOR_DECLARED' },
      ],
      [
        'I-4 preuve de course sur un retrait',
        { ...livre, deliveryProof: 'DELIVERY_CODE', payoutDueAt: later },
      ],
      [
        'I-5 confirmation client sans sa preuve',
        {
          ...livre,
          deliveryProof: 'PICKUP_VENDOR_DECLARED',
          customerConfirmedAt: new Date(),
        },
      ],
      [
        'I-5 preuve client sans date de confirmation',
        {
          ...livre,
          deliveryProof: 'PICKUP_CUSTOMER_CONFIRMED',
          payoutDueAt: later,
        },
      ],
      [
        'I-6 échéance sur une remise déclarée par le vendeur seul',
        {
          ...livre,
          deliveryProof: 'PICKUP_VENDOR_DECLARED',
          payoutDueAt: later,
        },
      ],
      [
        'I-7 preuve fiable sans échéance',
        { ...livre, deliveryProof: 'PICKUP_CODE' },
      ],
      [
        'I-8 échéance avant la remise',
        {
          ...livre,
          deliveryProof: 'PICKUP_CODE',
          payoutDueAt: new Date(Date.now() - 3_600_000),
        },
      ],
    ])('%s ⇒ rejet PostgreSQL', async (_label, data) => {
      await expect(
        prisma.order.update({ where: { id: ORDER }, data: data as never }),
      ).rejects.toThrow(/check constraint|violates/i);
    });

    it('les lignes antérieures (tout à NULL) restent valides', async () => {
      await expect(
        prisma.order.update({
          where: { id: ORDER },
          data: { status: OrderStatus.LIVRER },
        }),
      ).resolves.toMatchObject({ deliveryProof: null, payoutDueAt: null });
    });

    it('I-16 — délai de versement borné', async () => {
      await expect(
        prisma.platformSettings.create({
          data: { id: 'singleton', vendorPayoutDelayMinutes: 2000 },
        }),
      ).rejects.toThrow(/check constraint|violates/i);
    });
  });
});
