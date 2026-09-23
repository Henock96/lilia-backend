import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

/**
 * D-3 (Master Audit v1) — la base refuse elle-même un stock ou un solde
 * négatif, quel que soit l'écrivain (service, script, correction SQL).
 * Migration `20260923130000_money_stock_check_constraints`.
 */
const DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

describeIfDb('Contraintes CHECK — argent et stock (PostgreSQL réel)', () => {
  let prisma: PrismaClient;

  beforeAll(async () => {
    prisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: DATABASE_URL }),
    });
    await prisma.$connect();
    await prisma.$executeRawUnsafe(`
      TRUNCATE TABLE "ProductVariant", "Product", "Restaurant", "User"
      RESTART IDENTITY CASCADE
    `);
    await prisma.user.create({
      data: { id: 'ck-owner', firebaseUid: 'fb-ck', email: 'ck@test.local' },
    });
    await prisma.restaurant.create({
      data: {
        id: 'ck-vendor',
        nom: 'Chez Contrainte',
        adresse: 'Ouenzé',
        phone: '060000050',
        ownerId: 'ck-owner',
      },
    });
    await prisma.product.create({
      data: {
        id: 'ck-prod',
        nom: 'Beignets',
        prixOriginal: 500,
        restaurantId: 'ck-vendor',
        stockRestant: 1,
      },
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('un stock ne descend pas sous zéro, même par un UPDATE brut', async () => {
    await expect(
      prisma.$executeRaw`UPDATE "Product" SET "stockRestant" = "stockRestant" - 5 WHERE id = 'ck-prod'`,
    ).rejects.toThrow(/Product_price_stock_non_negative/);
    const p = await prisma.product.findUniqueOrThrow({
      where: { id: 'ck-prod' },
    });
    expect(p.stockRestant).toBe(1);
  });

  it('un solde de fidélité ne devient pas négatif', async () => {
    await expect(
      prisma.user.update({
        where: { id: 'ck-owner' },
        data: { loyaltyPoints: { decrement: 1 } },
      }),
    ).rejects.toThrow();
  });

  it('un stock illimité (NULL) reste autorisé', async () => {
    await prisma.product.update({
      where: { id: 'ck-prod' },
      data: { stockRestant: null },
    });
  });
});
