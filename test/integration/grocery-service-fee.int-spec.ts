import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

/**
 * D-4 — le taux de frais de service des épiceries, sur un **vrai PostgreSQL** :
 * la base elle-même refuse un taux hors de 0 → 10 000 points de base, quelle
 * que soit l'écriture (service, script, SQL manuel).
 */
const DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

describeIfDb('PlatformSettings.groceryServiceFeeBps (PostgreSQL réel)', () => {
  let prisma: PrismaClient;

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
    await prisma.platformSettings.deleteMany();
    await prisma.platformSettings.create({ data: { id: 'singleton' } });
  });

  const set = (groceryServiceFeeBps: number | null) =>
    prisma.platformSettings.update({
      where: { id: 'singleton' },
      data: { groceryServiceFeeBps },
    });

  it('naît NULL : le taux général s’applique, aucun prix ne change au déploiement', async () => {
    const row = await prisma.platformSettings.findUniqueOrThrow({
      where: { id: 'singleton' },
    });
    expect(row.groceryServiceFeeBps).toBeNull();
  });

  it.each([0, 500, 10_000])('accepte %i bps', async (bps) => {
    await expect(set(bps)).resolves.toMatchObject({
      groceryServiceFeeBps: bps,
    });
  });

  it('accepte de revenir à NULL', async () => {
    await set(500);
    await expect(set(null)).resolves.toMatchObject({
      groceryServiceFeeBps: null,
    });
  });

  it.each([-1, 10_001])('refuse %i bps (CHECK en base)', async (bps) => {
    await expect(set(bps)).rejects.toThrow(
      /PlatformSettings_grocery_service_fee_range/,
    );
  });
});
