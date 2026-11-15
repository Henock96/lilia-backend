import { PrismaPg } from '@prisma/adapter-pg';
import { ConflictException, ForbiddenException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  DeliveryStatus,
  DriverStatus,
  OrderStatus,
  PrismaClient,
} from '@prisma/client';

import { DeliveryAssignmentLogService } from '../../apps/lilia-app/src/modules/deliveries/delivery-assignment-log.service';
import { DeliveryArbitrationService } from '../../apps/lilia-app/src/modules/orders/delivery-arbitration.service';
import { OrderStateMachine } from '../../apps/lilia-app/src/modules/orders/order-state.machine';
import { OrderTransitionService } from '../../apps/lilia-app/src/modules/orders/order-transition.service';
import { OutboxService } from '../../apps/lilia-app/src/modules/outbox/outbox.service';

/**
 * **Arbitrage de livraison (retours produit du 15/11/2026, D1).**
 *
 * L'ADMIN clôture une livraison sans le livreur — typiquement un client qui
 * refuse une commande payée. Ce qui doit tenir, en base réelle :
 *  - `PRET → EN_ROUTE → LIVRER` (ou `EN_ROUTE → LIVRER`), preuve
 *    `DELIVERY_ADMIN_OVERRIDE`, échéance de versement vendeur posée ;
 *  - aucun remboursement, aucune récompense (`order.delivered` absent) ;
 *  - l'avoir, nominatif et unique, naît avec la clôture ou pas du tout ;
 *  - un livreur qui n'a pas le repas est détaché sans être payé ; celui qui
 *    l'a termine sa course ;
 *  - rejeu et concurrence : une seule clôture, un seul avoir.
 */
const DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

describeIfDb('Arbitrage de livraison ADMIN (PostgreSQL réel)', () => {
  let prisma: PrismaClient;
  let events: EventEmitter2;

  const ADMIN_UID = 'fb-darb-admin';
  const ORDER = 'darb-order';
  const DELIVERY = 'darb-delivery';
  const DRIVER = 'darb-driver';

  function service() {
    return new DeliveryArbitrationService(
      prisma as never,
      new OrderStateMachine(),
      new OrderTransitionService(),
      new DeliveryAssignmentLogService(),
      new OutboxService(prisma as never),
      events,
    );
  }

  beforeAll(async () => {
    prisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: DATABASE_URL }),
    });
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    events = new EventEmitter2();
    await prisma.$executeRawUnsafe(`
      TRUNCATE TABLE "AdminAuditLog", "OutboxEvent", "PromoCode", "Refund",
                     "DeliveryAssignment", "Delivery", "OrderItem",
                     "OrderHistory", "Order", "Restaurant", "User",
                     "PlatformSettings"
      RESTART IDENTITY CASCADE
    `);
    await prisma.user.createMany({
      data: [
        {
          id: 'darb-owner',
          firebaseUid: 'fb-darb-owner',
          email: 'darb-o@test.local',
          role: 'RESTAURATEUR',
        },
        {
          id: 'darb-client',
          firebaseUid: 'fb-darb-client',
          email: 'darb-c@test.local',
        },
        {
          id: 'darb-admin',
          firebaseUid: ADMIN_UID,
          email: 'darb-a@test.local',
          role: 'ADMIN',
        },
        {
          id: DRIVER,
          firebaseUid: 'fb-darb-driver',
          email: 'darb-d@test.local',
          role: 'LIVREUR',
          driverStatus: DriverStatus.AVAILABLE,
        },
      ],
    });
    await prisma.restaurant.create({
      data: {
        id: 'darb-vendor',
        nom: 'Chez Arbitre',
        adresse: 'Poto-Poto',
        phone: '060000061',
        ownerId: 'darb-owner',
      },
    });
  });

  async function createOrder(
    status: OrderStatus,
    opts: { isDelivery?: boolean } = {},
  ) {
    await prisma.order.create({
      data: {
        id: ORDER,
        restaurantId: 'darb-vendor',
        userId: 'darb-client',
        subTotal: 4000,
        deliveryFee: 1000,
        deliveryFeeGross: 1000,
        total: 5000,
        paymentMethod: 'MTN_MOMO',
        isDelivery: opts.isDelivery ?? true,
        status,
      },
    });
  }

  /** Course au statut donné ; avec livreur, sa main est ouverte au journal. */
  async function createDelivery(status: DeliveryStatus, withDriver = true) {
    await prisma.delivery.create({
      data: {
        id: DELIVERY,
        orderId: ORDER,
        status,
        delivererId: withDriver ? DRIVER : null,
        ...(withDriver ? { driverPayXaf: 800 } : {}),
      },
    });
    if (!withDriver) return;
    await prisma.deliveryAssignment.create({
      data: {
        deliveryId: DELIVERY,
        orderId: ORDER,
        delivererId: DRIVER,
        assignedByUserId: 'darb-admin',
        assignedByRole: 'ADMIN',
      },
    });
    if (
      status === DeliveryStatus.ACCEPTER ||
      status === DeliveryStatus.EN_TRANSIT
    ) {
      await prisma.user.update({
        where: { id: DRIVER },
        data: { driverStatus: DriverStatus.ON_DELIVERY },
      });
    }
  }

  const readOrder = () =>
    prisma.order.findUniqueOrThrow({ where: { id: ORDER } });
  const refused = { reason: 'CUSTOMER_REFUSED' as const };

  it('PRET sans course : PRET → EN_ROUTE → LIVRER, preuve admin, échéance, journal, sans récompense', async () => {
    await createOrder(OrderStatus.PRET);

    const result = await service().arbitrate(ORDER, ADMIN_UID, {
      ...refused,
      note: 'Le client a refusé à la porte',
    });

    expect(result).toMatchObject({
      status: 'LIVRER',
      deliveryProof: 'DELIVERY_ADMIN_OVERRIDE',
      voucher: null,
    });
    const order = await readOrder();
    expect(order.status).toBe('LIVRER');
    expect(order.deliveryProof).toBe('DELIVERY_ADMIN_OVERRIDE');
    expect(order.payoutDueAt).not.toBeNull();

    const history = await prisma.orderHistory.findMany({
      where: { orderId: ORDER },
      orderBy: { createdAt: 'asc' },
    });
    expect(history.map((h) => [h.fromStatus, h.toStatus, h.actionId])).toEqual([
      ['PRET', 'EN_ROUTE', 'ADMIN'],
      ['EN_ROUTE', 'LIVRER', 'ADMIN'],
    ]);
    expect(history[1].reason).toContain('refus du client');
    expect(history[1].reason).toContain('Le client a refusé à la porte');

    const audit = await prisma.adminAuditLog.findMany({
      where: { targetId: ORDER, action: 'ORDER_STATUS_FORCED' },
    });
    expect(audit).toHaveLength(1);
    expect(audit[0].metadata).toMatchObject({
      kind: 'DELIVERY_ARBITRATION',
      from: 'PRET',
      to: 'LIVRER',
      reason: 'CUSTOMER_REFUSED',
      delivery: null,
      voucher: null,
    });

    // D1.c — ni fidélité ni parrainage ; aucun remboursement.
    const outbox = await prisma.outboxEvent.findMany({
      where: { aggregateId: ORDER },
    });
    expect(outbox.map((e) => e.type)).not.toContain('order.delivered');
    expect(outbox.map((e) => e.type)).not.toContain('order.refund_due');
  });

  it('avec avoir : code nominatif à usage unique, financé par la plateforme, push durable', async () => {
    await createOrder(OrderStatus.PRET);

    const result = await service().arbitrate(ORDER, ADMIN_UID, {
      ...refused,
      voucherAmountXaf: 2500,
      voucherExpiresInDays: 15,
    });

    expect(result.voucher?.code).toMatch(/^AVOIR-[A-Z2-9]{8}$/);
    expect(result.voucher?.amountXaf).toBe(2500);
    const promos = await prisma.promoCode.findMany();
    expect(promos).toHaveLength(1);
    expect(promos[0]).toMatchObject({
      code: result.voucher!.code,
      discountType: 'FIXED',
      discountValue: 2500,
      maxUsageTotal: 1,
      maxUsagePerUser: 1,
      assignedUserId: 'darb-client',
      fundingSource: 'PLATFORM',
    });
    const days = (promos[0].expiresAt!.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(14.9);
    expect(days).toBeLessThan(15.1);

    const voucherEvents = await prisma.outboxEvent.findMany({
      where: { aggregateId: ORDER, type: 'order.voucher_issued' },
    });
    expect(voucherEvents).toHaveLength(1);
    expect(voucherEvents[0].payload).toEqual({ promoCodeId: promos[0].id });
  });

  it('avoir supérieur au total payé : refusé, rien n’est écrit', async () => {
    await createOrder(OrderStatus.PRET);

    await expect(
      service().arbitrate(ORDER, ADMIN_UID, {
        ...refused,
        voucherAmountXaf: 5001,
      }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'VOUCHER_EXCEEDS_TOTAL' }),
    });
    expect((await readOrder()).status).toBe('PRET');
    expect(await prisma.promoCode.count()).toBe(0);
    expect(await prisma.orderHistory.count()).toBe(0);
  });

  it('plafond net : les remboursements déjà comptés réduisent l’avoir possible', async () => {
    await createOrder(OrderStatus.PRET);
    // Remboursement en attente : compté (une seule ligne ouverte par
    // commande, contrainte en base).
    await prisma.refund.create({
      data: { orderId: ORDER, amount: 3000, reason: 'Article manquant' },
    });

    await expect(
      service().arbitrate(ORDER, ADMIN_UID, {
        ...refused,
        voucherAmountXaf: 2500,
      }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'VOUCHER_EXCEEDS_TOTAL' }),
    });
    expect((await readOrder()).status).toBe('PRET');

    const result = await service().arbitrate(ORDER, ADMIN_UID, {
      ...refused,
      voucherAmountXaf: 2000,
    });
    expect(result.voucher?.amountXaf).toBe(2000);

    // Le code vaut paiement : il n'est pas recopié dans le journal d'audit.
    const audit = await prisma.adminAuditLog.findFirstOrThrow({
      where: { targetId: ORDER },
    });
    expect(JSON.stringify(audit.metadata)).not.toContain(result.voucher!.code);
  });

  it('rejeu : la seconde requête est refusée et n’émet aucun second avoir', async () => {
    await createOrder(OrderStatus.PRET);
    const input = { ...refused, voucherAmountXaf: 1000 };

    await service().arbitrate(ORDER, ADMIN_UID, input);
    await expect(
      service().arbitrate(ORDER, ADMIN_UID, input),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(await prisma.promoCode.count()).toBe(1);
    expect(
      await prisma.adminAuditLog.count({ where: { targetId: ORDER } }),
    ).toBe(1);
  });

  it('deux administrateurs en même temps : une clôture, un avoir', async () => {
    await createOrder(OrderStatus.PRET);
    const input = { ...refused, voucherAmountXaf: 1000 };

    const results = await Promise.allSettled([
      service().arbitrate(ORDER, ADMIN_UID, input),
      service().arbitrate(ORDER, ADMIN_UID, input),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter(
      (r): r is PromiseRejectedResult => r.status === 'rejected',
    );
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(ConflictException);
    expect(await prisma.promoCode.count()).toBe(1);
    expect(
      await prisma.orderHistory.count({ where: { toStatus: 'LIVRER' } }),
    ).toBe(1);
  });

  it('livreur qui n’a pas le repas (ACCEPTER) : course fermée, livreur détaché, libéré et prévenu', async () => {
    await createOrder(OrderStatus.PRET);
    await createDelivery(DeliveryStatus.ACCEPTER);
    const unassigned: unknown[] = [];
    events.on('delivery.unassigned', (e) => unassigned.push(e));

    await service().arbitrate(ORDER, ADMIN_UID, refused);

    const delivery = await prisma.delivery.findUniqueOrThrow({
      where: { id: DELIVERY },
    });
    expect(delivery.status).toBe('ECHEC');
    expect(delivery.delivererId).toBeNull();
    expect(delivery.driverPayXaf).toBeNull();
    const hand = await prisma.deliveryAssignment.findFirstOrThrow({
      where: { deliveryId: DELIVERY },
    });
    expect(hand.outcome).toBe('ORDER_CANCELLED');
    expect(hand.releasedAt).not.toBeNull();
    const driver = await prisma.user.findUniqueOrThrow({
      where: { id: DRIVER },
    });
    expect(driver.driverStatus).toBe('AVAILABLE');
    expect(unassigned).toEqual([
      expect.objectContaining({
        delivererId: DRIVER,
        cause: 'order_closed_by_admin',
      }),
    ]);
  });

  it('livreur qui a le repas (EN_TRANSIT) : sa course s’achève, remise admin, main COMPLETED', async () => {
    await createOrder(OrderStatus.EN_ROUTE);
    await createDelivery(DeliveryStatus.EN_TRANSIT);
    const unassigned: unknown[] = [];
    events.on('delivery.unassigned', (e) => unassigned.push(e));

    await service().arbitrate(ORDER, ADMIN_UID, {
      reason: 'DRIVER_DID_NOT_CONFIRM',
    });

    const delivery = await prisma.delivery.findUniqueOrThrow({
      where: { id: DELIVERY },
    });
    expect(delivery.status).toBe('LIVRER');
    expect(delivery.handoverMethod).toBe('ADMIN_OVERRIDE');
    expect(delivery.deliveredAt).not.toBeNull();
    expect(delivery.delivererId).toBe(DRIVER);
    expect(delivery.driverPayXaf).toBe(800);
    const hand = await prisma.deliveryAssignment.findFirstOrThrow({
      where: { deliveryId: DELIVERY },
    });
    expect(hand.outcome).toBe('COMPLETED');
    const driver = await prisma.user.findUniqueOrThrow({
      where: { id: DRIVER },
    });
    expect(driver.driverStatus).toBe('AVAILABLE');
    expect(unassigned).toEqual([]);

    const history = await prisma.orderHistory.findMany({
      where: { orderId: ORDER },
    });
    expect(history.map((h) => [h.fromStatus, h.toStatus])).toEqual([
      ['EN_ROUTE', 'LIVRER'],
    ]);
  });

  it('hors périmètre : retrait, commande en préparation, commande déjà livrée', async () => {
    await createOrder(OrderStatus.PRET, { isDelivery: false });
    await expect(
      service().arbitrate(ORDER, ADMIN_UID, refused),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: 'DELIVERY_ARBITRATION_NOT_APPLICABLE',
      }),
    });

    for (const status of [OrderStatus.EN_PREPARATION, OrderStatus.LIVRER]) {
      await prisma.order.update({
        where: { id: ORDER },
        data: { status, isDelivery: true },
      });
      await expect(
        service().arbitrate(ORDER, ADMIN_UID, refused),
      ).rejects.toMatchObject({
        response: expect.objectContaining({
          code: 'DELIVERY_ARBITRATION_NOT_APPLICABLE',
        }),
      });
    }
    expect(await prisma.orderHistory.count()).toBe(0);
  });

  it('un compte non ADMIN est refusé, même si la route était franchie', async () => {
    await createOrder(OrderStatus.PRET);
    await expect(
      service().arbitrate(ORDER, 'fb-darb-owner', refused),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect((await readOrder()).status).toBe('PRET');
  });
});
