import { PrismaPg } from '@prisma/adapter-pg';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { OrderStatus, PrismaClient } from '@prisma/client';

import { OrderLifecycleService } from '../../apps/lilia-app/src/modules/orders/order-lifecycle.service';
import { OrderStateMachine } from '../../apps/lilia-app/src/modules/orders/order-state.machine';
import { OrderTransitionService } from '../../apps/lilia-app/src/modules/orders/order-transition.service';
import { StockService } from '../../apps/lilia-app/src/modules/orders/stock.service';
import { RefundsService } from '../../apps/lilia-app/src/modules/refunds/refunds.service';
import { OutboxService } from '../../apps/lilia-app/src/modules/outbox/outbox.service';
import {
  accessibleShopIds,
  orderNotificationRecipients,
} from '../../apps/lilia-app/src/modules/vendors/shop-access';
import { ShopMembershipService } from '../../apps/lilia-app/src/modules/vendors/shop-membership.service';

/**
 * Durcissement lot 3 (point 7) — `ShopMembership` sur PostgreSQL réel.
 *
 *  - le propriétaire historique garde ses accès SANS ligne de membre (compat) ;
 *  - un membre STAFF traite les commandes de SA boutique, jamais d'une autre ;
 *  - révoqué, il perd l'accès immédiatement ;
 *  - seul le propriétaire (ou un admin) gère les membres ;
 *  - la base garantit un seul propriétaire actif et une adhésion vivante par
 *    compte et boutique.
 */
const DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

describeIfDb('Membres de boutique (PostgreSQL réel)', () => {
  let prisma: PrismaClient;
  let lifecycle: OrderLifecycleService;
  let members: ShopMembershipService;

  const OWNER_A = { id: 'sm-owner-a', uid: 'fb-sm-oa' };
  const OWNER_B = { id: 'sm-owner-b', uid: 'fb-sm-ob' };
  const STAFF = { id: 'sm-staff', uid: 'fb-sm-st', email: 'staff@t.local' };

  beforeAll(async () => {
    prisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: DATABASE_URL }),
    });
    await prisma.$connect();
    lifecycle = new OrderLifecycleService(
      prisma as never,
      new EventEmitter2(),
      new OrderStateMachine(),
      new OrderTransitionService(),
      new StockService(),
      { awardForDeliveredOrder: async () => 0 } as never,
      { rewardForDeliveredOrder: async () => undefined } as never,
      new RefundsService(prisma as never),
      { record: async () => undefined } as never,
      new OutboxService(prisma as never),
      { announce: async () => undefined } as never,
    );
    members = new ShopMembershipService(prisma as never);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(`
      TRUNCATE TABLE "ShopMembership", "OrderItem", "OrderHistory", "payments",
                     "Refund", "OutboxEvent", "Order", "Restaurant", "User",
                     "PlatformSettings"
      RESTART IDENTITY CASCADE
    `);
    await prisma.user.createMany({
      data: [
        {
          id: OWNER_A.id,
          firebaseUid: OWNER_A.uid,
          email: 'oa@t.local',
          role: 'RESTAURATEUR',
        },
        {
          id: OWNER_B.id,
          firebaseUid: OWNER_B.uid,
          email: 'ob@t.local',
          role: 'RESTAURATEUR',
        },
        {
          id: STAFF.id,
          firebaseUid: STAFF.uid,
          email: STAFF.email,
          role: 'RESTAURATEUR',
        },
        { id: 'sm-client', firebaseUid: 'fb-sm-c', email: 'c@t.local' },
      ],
    });
    await prisma.restaurant.createMany({
      data: [
        {
          id: 'shop-a',
          nom: 'A',
          adresse: 'Poto-Poto',
          phone: '060000011',
          ownerId: OWNER_A.id,
        },
        {
          id: 'shop-b',
          nom: 'B',
          adresse: 'Bacongo',
          phone: '060000012',
          ownerId: OWNER_B.id,
        },
      ],
    });
    for (const [id, shop] of [
      ['order-a', 'shop-a'],
      ['order-b', 'shop-b'],
    ] as const) {
      await prisma.order.create({
        data: {
          id,
          restaurantId: shop,
          userId: 'sm-client',
          subTotal: 3000,
          deliveryFee: 1000,
          serviceFee: 450,
          total: 4450,
          paymentMethod: 'MTN_MOMO',
          status: OrderStatus.PAYER,
        },
      });
    }
  });

  const addStaffToA = () =>
    members.add({ id: OWNER_A.id, role: 'RESTAURATEUR' }, 'shop-a', {
      email: STAFF.email,
      role: 'STAFF',
    });

  it('compatibilité : le propriétaire agit sans ligne de membre', async () => {
    await lifecycle.acceptOrder('order-a', OWNER_A.uid, 20);
    expect(
      (await prisma.order.findUniqueOrThrow({ where: { id: 'order-a' } }))
        .status,
    ).toBe(OrderStatus.ACCEPTEE);
  });

  it('un membre STAFF accepte une commande de SA boutique', async () => {
    await addStaffToA();
    await lifecycle.acceptOrder('order-a', STAFF.uid, 15);
    expect(
      (await prisma.order.findUniqueOrThrow({ where: { id: 'order-a' } }))
        .status,
    ).toBe(OrderStatus.ACCEPTEE);
    expect(
      await accessibleShopIds(prisma as never, STAFF.id, 'ORDERS'),
    ).toEqual(['shop-a']);
  });

  it('isolation : ni le membre de A, ni le propriétaire de B ne touchent la commande de l’autre', async () => {
    await addStaffToA();
    await expect(
      lifecycle.acceptOrder('order-b', STAFF.uid, 15),
    ).rejects.toThrow(/n'appartient pas/);
    await expect(
      lifecycle.acceptOrder('order-a', OWNER_B.uid, 15),
    ).rejects.toThrow(/n'appartient pas/);
    const statuses = await prisma.order.findMany({ select: { status: true } });
    expect(statuses.every((o) => o.status === OrderStatus.PAYER)).toBe(true);
  });

  it('révoqué, le membre perd l’accès immédiatement', async () => {
    const m = await addStaffToA();
    await members.revoke(
      { id: OWNER_A.id, role: 'RESTAURATEUR' },
      'shop-a',
      m.id,
      'fin de contrat',
    );
    await expect(
      lifecycle.acceptOrder('order-a', STAFF.uid, 15),
    ).rejects.toThrow(/n'appartient pas/);
    expect(
      await accessibleShopIds(prisma as never, STAFF.id, 'ORDERS'),
    ).toEqual([]);
  });

  it('un STAFF ne gère pas les membres ; un autre propriétaire non plus', async () => {
    await addStaffToA();
    await expect(
      members.list({ id: STAFF.id, role: 'RESTAURATEUR' }, 'shop-a'),
    ).rejects.toThrow(/propriétaire/);
    await expect(
      members.list({ id: OWNER_B.id, role: 'RESTAURATEUR' }, 'shop-a'),
    ).rejects.toThrow(/propriétaire/);
  });

  it('notifications : propriétaire puis membres actifs qui traitent les commandes', async () => {
    await addStaffToA();
    expect(
      await orderNotificationRecipients(prisma as never, 'shop-a'),
    ).toEqual([OWNER_A.id, STAFF.id]);
    expect(
      await orderNotificationRecipients(prisma as never, 'shop-b'),
    ).toEqual([OWNER_B.id]);
  });

  it('un compte non vendeur ne devient pas membre en douce', async () => {
    await expect(
      members.add({ id: OWNER_A.id, role: 'RESTAURATEUR' }, 'shop-a', {
        email: 'c@t.local',
        role: 'STAFF',
      }),
    ).rejects.toMatchObject({ response: { code: 'MEMBER_ROLE_REQUIRED' } });
  });

  describe('garanties de la base', () => {
    it('une seule adhésion vivante par compte et boutique', async () => {
      await addStaffToA();
      await expect(addStaffToA()).rejects.toThrow(/déjà membre/);
    });

    it('un seul propriétaire actif par boutique', async () => {
      await prisma.shopMembership.create({
        data: { userId: OWNER_A.id, restaurantId: 'shop-a', role: 'OWNER' },
      });
      await expect(
        prisma.shopMembership.create({
          data: { userId: STAFF.id, restaurantId: 'shop-a', role: 'OWNER' },
        }),
      ).rejects.toThrow(/ShopMembership_one_active_owner_uq|Unique constraint/);
    });

    it('révocation incomplète refusée', async () => {
      await expect(
        prisma.shopMembership.create({
          data: {
            userId: STAFF.id,
            restaurantId: 'shop-a',
            role: 'STAFF',
            status: 'REVOKED',
          },
        }),
      ).rejects.toThrow(/ShopMembership_revocation_complete/);
    });
  });
});
