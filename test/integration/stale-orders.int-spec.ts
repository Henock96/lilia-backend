import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

import {
  loadStaleCandidates,
  evaluateStale,
} from '../../apps/lilia-app/src/modules/ops/stale-orders';

/**
 * Point 6 (audit du 28/10/2026) — la requête des commandes immobiles, sur
 * PostgreSQL réel : entrée dans l'état lue sur OrderHistory, repli sur
 * updatedAt, états terminaux exclus.
 */
const DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

describeIfDb('Commandes immobiles (PostgreSQL réel)', () => {
  let prisma: PrismaClient;
  const now = new Date();
  const ago = (m: number) => new Date(now.getTime() - m * 60_000);

  beforeAll(async () => {
    prisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: DATABASE_URL }),
    });
    await prisma.$connect();
    await prisma.$executeRawUnsafe(
      `TRUNCATE TABLE "OrderHistory", "Order", "Restaurant", "User" RESTART IDENTITY CASCADE`,
    );
    await prisma.user.createMany({
      data: [
        {
          id: 'so-owner',
          firebaseUid: 'fb-so-o',
          email: 'so-o@test.local',
          role: 'RESTAURATEUR',
        },
        { id: 'so-client', firebaseUid: 'fb-so-c', email: 'so-c@test.local' },
      ],
    });
    await prisma.restaurant.create({
      data: {
        id: 'so-shop',
        nom: 'Chez Immobile',
        adresse: 'Moungali',
        phone: '060000070',
        ownerId: 'so-owner',
      },
    });
    const order = (id: string, status: string, updatedAt: Date) =>
      prisma.$executeRaw`
        INSERT INTO "Order" (id, "restaurantId", "userId", "subTotal", "deliveryFee", total, "paymentMethod", status, "createdAt", "updatedAt")
        VALUES (${id}, 'so-shop', 'so-client', 1000, 0, 1000, 'MTN_MOMO', ${status}::"OrderStatus", ${ago(600)}, ${updatedAt})`;

    // En préparation depuis 60 min (historique), modifiée il y a 1 min.
    await order('so-prep', 'EN_PREPARATION', ago(1));
    await prisma.orderHistory.create({
      data: {
        orderId: 'so-prep',
        fromStatus: 'ACCEPTEE',
        toStatus: 'EN_PREPARATION',
        actionId: 'RESTAURATEUR',
        createdAt: ago(60),
      },
    });
    // Acceptée sans historique, immobile depuis 30 min.
    await order('so-acc', 'ACCEPTEE', ago(30));
    // Livrée il y a longtemps : terminale, jamais signalée.
    await order('so-done', 'LIVRER', ago(500));
    // En préparation depuis 2 min : trop récente.
    await order('so-fresh', 'EN_PREPARATION', ago(2));
    await prisma.orderHistory.create({
      data: {
        orderId: 'so-fresh',
        fromStatus: 'ACCEPTEE',
        toStatus: 'EN_PREPARATION',
        actionId: 'RESTAURATEUR',
        createdAt: ago(2),
      },
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('lit l’entrée dans l’état sur l’historique et exclut les terminales', async () => {
    const rows = await loadStaleCandidates(prisma as never, now);
    const ids = rows.map((r) => r.id).sort();
    expect(ids).toEqual(['so-acc', 'so-prep']);
    const prep = rows.find((r) => r.id === 'so-prep')!;
    expect(prep.enteredAt?.getTime()).toBe(ago(60).getTime());
    expect(prep.shopName).toBe('Chez Immobile');
  });

  it('de bout en bout : l’ancienneté vient de l’historique, pas de updatedAt', async () => {
    const rows = await loadStaleCandidates(prisma as never, now);
    const stale = rows.map((r) => evaluateStale(r, now)).filter(Boolean);
    const prep = stale.find((s) => s!.orderId === 'so-prep')!;
    expect(prep.since.getTime()).toBe(ago(60).getTime());
    expect(prep.sinceSource).toBe('HISTORY');
    const acc = stale.find((s) => s!.orderId === 'so-acc')!;
    expect(acc.sinceSource).toBe('UPDATED_AT');
  });
});
