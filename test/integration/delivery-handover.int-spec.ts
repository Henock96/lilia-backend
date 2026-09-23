import { PrismaPg } from '@prisma/adapter-pg';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DeliveryStatus, OrderStatus, PrismaClient } from '@prisma/client';

import { DeliveriesService } from '../../apps/lilia-app/src/modules/deliveries/deliveries.service';
import { DeliveryAssignmentLogService } from '../../apps/lilia-app/src/modules/deliveries/delivery-assignment-log.service';
import { DeliveryAssignmentService } from '../../apps/lilia-app/src/modules/deliveries/delivery-assignment.service';
import { DeliveryQueryService } from '../../apps/lilia-app/src/modules/deliveries/delivery-query.service';
import { DeliveryStatus as DeliveryStatusDto } from '../../apps/lilia-app/src/modules/deliveries/dto/update-delivery.dto';
import { HANDOVER_MAX_ATTEMPTS } from '../../apps/lilia-app/src/modules/deliveries/delivery-handover';
import { OrderStateMachine } from '../../apps/lilia-app/src/modules/orders/order-state.machine';
import { OrderTransitionService } from '../../apps/lilia-app/src/modules/orders/order-transition.service';
import { OutboxService } from '../../apps/lilia-app/src/modules/outbox/outbox.service';
import { PlatformSettingsService } from '../../apps/lilia-app/src/modules/platform-settings/platform-settings.service';

/**
 * **F-06 (Master Audit v1) — « Livré » exige la preuve que le client a reçu.**
 *
 * Contre un vrai PostgreSQL, parce que la garantie centrale est une garantie
 * de base de données : chaque saisie consomme un essai par un `UPDATE …
 * WHERE attempts < 5` atomique. Une rafale de requêtes parallèles ne doit donc
 * pas tester plus de codes qu'une saisie à la main.
 */
/** Le statut tel que le contrôleur le reçoit (enum du DTO). */
const LIVRER = DeliveryStatusDto.LIVRER;

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

describeIfDb('Preuve de remise — code client (PostgreSQL réel)', () => {
  let prisma: PrismaClient;
  let assignment: DeliveryAssignmentService;
  const audit: { record: jest.Mock } = { record: jest.fn() };
  const build = (required: boolean) =>
    new DeliveriesService(
      prisma as never,
      { sendPushNotification: async () => undefined } as never,
      new EventEmitter2(),
      new OrderStateMachine(),
      new OrderTransitionService(),
      { broadcastOrderStatus: () => undefined } as never,
      { forgetLastPosition: async () => undefined } as never,
      new DeliveryQueryService(
        prisma as never,
        new DeliveryAssignmentLogService(),
      ),
      assignment,
      { awardForDeliveredOrder: async () => undefined } as never,
      { rewardForDeliveredOrder: async () => undefined } as never,
      new DeliveryAssignmentLogService(),
      new OutboxService(prisma as never),
      audit as never,
      { get: () => required } as never,
    );

  const OWNER_UID = 'fb-ho-owner';
  const CLIENT_UID = 'fb-ho-client';
  const DRIVER_UID = 'fb-ho-driver';
  const ADMIN_UID = 'fb-ho-admin';
  const DELIVERY = 'ho-delivery';
  const ORDER = 'ho-order';

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
      { forgetLastPosition: async () => undefined } as never,
    );
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  /** Une course récupérée : le code vient d'être tiré. */
  beforeEach(async () => {
    audit.record.mockClear();
    await prisma.$executeRawUnsafe(`
      TRUNCATE TABLE "DeliveryHandover", "DeliveryAssignment", "DeliveryReview",
                     "DeliveryLocation", "Delivery", "OutboxEvent",
                     "OrderItem", "OrderHistory", "Order", "DriverProfile",
                     "Restaurant", "User"
      RESTART IDENTITY CASCADE
    `);
    await prisma.user.createMany({
      data: [
        {
          id: 'ho-owner',
          firebaseUid: OWNER_UID,
          email: 'ho-o@test.local',
          role: 'RESTAURATEUR',
        },
        { id: 'ho-client', firebaseUid: CLIENT_UID, email: 'ho-c@test.local' },
        {
          id: 'ho-admin',
          firebaseUid: ADMIN_UID,
          email: 'ho-a@test.local',
          role: 'ADMIN',
        },
        {
          id: 'ho-driver',
          firebaseUid: DRIVER_UID,
          email: 'ho-d@test.local',
          role: 'LIVREUR',
          driverStatus: 'AVAILABLE',
        },
      ],
    });
    await prisma.driverProfile.create({
      data: { userId: 'ho-driver', isActive: true },
    });
    await prisma.restaurant.create({
      data: {
        id: 'ho-vendor',
        nom: 'Chez Remise',
        adresse: 'Moungali',
        phone: '060000040',
        ownerId: 'ho-owner',
      },
    });
    await prisma.order.create({
      data: {
        id: ORDER,
        restaurantId: 'ho-vendor',
        userId: 'ho-client',
        subTotal: 4000,
        deliveryFee: 1000,
        deliveryFeeGross: 1000,
        total: 5000,
        paymentMethod: 'MTN_MOMO',
        status: OrderStatus.PRET,
      },
    });
    await prisma.delivery.create({
      data: { id: DELIVERY, orderId: ORDER, status: DeliveryStatus.EN_ATTENTE },
    });
    await assignment.assignDeliverer(DELIVERY, 'ho-driver', OWNER_UID);
    await assignment.acceptDelivery(DELIVERY, DRIVER_UID);
    await assignment.confirmPickup(DELIVERY, DRIVER_UID);
  });

  const codeOf = async () =>
    (
      await prisma.deliveryHandover.findUniqueOrThrow({
        where: { deliveryId: DELIVERY },
      })
    ).code;
  const wrong = (code: string) => (code === '0000' ? '1111' : '0000');

  it('le retrait tire un code à 4 chiffres, que seul le client lit', async () => {
    const code = await codeOf();
    expect(code).toMatch(/^\d{4}$/);

    const svc = build(true);
    const client = await svc.findByOrderId(ORDER, CLIENT_UID);
    expect(client.data.handoverCode).toBe(code);
    const driver = await svc.findByOrderId(ORDER, DRIVER_UID);
    expect(driver.data.handoverCode).toBeNull();
    const vendor = await svc.findByOrderId(ORDER, OWNER_UID);
    expect(vendor.data.handoverCode).toBeNull();
  });

  it('code exigé : sans code, pas de « Livré »', async () => {
    await expect(
      build(true).updateStatus(DELIVERY, LIVRER, DRIVER_UID),
    ).rejects.toThrow(/code de remise/);
    const order = await prisma.order.findUniqueOrThrow({
      where: { id: ORDER },
    });
    expect(order.status).toBe(OrderStatus.EN_ROUTE);
  });

  it('bon code : livrée, attestée CODE, obligation de récompense écrite', async () => {
    await build(true).updateStatus(
      DELIVERY,
      LIVRER,
      DRIVER_UID,
      undefined,
      await codeOf(),
    );
    const delivery = await prisma.delivery.findUniqueOrThrow({
      where: { id: DELIVERY },
    });
    expect(delivery).toMatchObject({
      status: 'LIVRER',
      handoverMethod: 'CODE',
    });
    expect(delivery.handoverVerifiedAt).toBeInstanceOf(Date);
    expect(
      await prisma.outboxEvent.count({
        where: { aggregateId: ORDER, type: 'order.delivered' },
      }),
    ).toBe(1);
  });

  it('rafale de 30 codes en parallèle : au plus 5 essais consommés, course verrouillée', async () => {
    const code = await codeOf();
    const svc = build(true);
    // 30 mauvais codes distincts, envoyés d'un coup.
    const guesses = Array.from({ length: 30 }, (_, i) =>
      String((Number(code) + 1 + i) % 10_000).padStart(4, '0'),
    );
    await Promise.allSettled(
      guesses.map((g) =>
        svc.updateStatus(DELIVERY, LIVRER, DRIVER_UID, undefined, g),
      ),
    );
    const handover = await prisma.deliveryHandover.findUniqueOrThrow({
      where: { deliveryId: DELIVERY },
    });
    expect(handover.attempts).toBe(HANDOVER_MAX_ATTEMPTS);

    // Même le BON code ne passe plus : seul un ADMIN peut conclure.
    await expect(
      svc.updateStatus(DELIVERY, LIVRER, DRIVER_UID, undefined, code),
    ).rejects.toThrow(/Trop de codes erronés/);
    const order = await prisma.order.findUniqueOrThrow({
      where: { id: ORDER },
    });
    expect(order.status).toBe(OrderStatus.EN_ROUTE);
  });

  it('un mauvais code annonce les essais restants et ne conclut rien', async () => {
    const code = await codeOf();
    await expect(
      build(true).updateStatus(
        DELIVERY,
        LIVRER,
        DRIVER_UID,
        undefined,
        wrong(code),
      ),
    ).rejects.toThrow(/4 essais restants/);
    expect(
      (await prisma.delivery.findUniqueOrThrow({ where: { id: DELIVERY } }))
        .status,
    ).toBe('EN_TRANSIT');
  });

  it('arbitrage ADMIN : conclut sans code, attesté ADMIN_OVERRIDE et audité', async () => {
    await build(true).updateStatus(
      DELIVERY,
      LIVRER,
      ADMIN_UID,
      'client injoignable, remise confirmée par téléphone',
    );
    const delivery = await prisma.delivery.findUniqueOrThrow({
      where: { id: DELIVERY },
    });
    expect(delivery.handoverMethod).toBe('ADMIN_OVERRIDE');
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'ORDER_STATUS_FORCED',
        targetId: ORDER,
        reason: 'client injoignable, remise confirmée par téléphone',
      }),
    );
  });

  it('période de transition (code non exigé) : sans code, livrée mais attestée UNVERIFIED', async () => {
    await build(false).updateStatus(DELIVERY, LIVRER, DRIVER_UID);
    const delivery = await prisma.delivery.findUniqueOrThrow({
      where: { id: DELIVERY },
    });
    expect(delivery).toMatchObject({
      status: 'LIVRER',
      handoverMethod: 'UNVERIFIED',
    });
  });

  it('période de transition : un code FOURNI et faux reste refusé', async () => {
    await expect(
      build(false).updateStatus(
        DELIVERY,
        LIVRER,
        DRIVER_UID,
        undefined,
        wrong(await codeOf()),
      ),
    ).rejects.toThrow(/incorrect/);
  });
});
