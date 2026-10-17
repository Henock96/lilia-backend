import { randomUUID } from 'crypto';

import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import Redis from 'ioredis';

import { ProductCommandService } from '../../apps/lilia-app/src/modules/products/product-command.service';

/**
 * ADM-01 — « Réapprovisionner +N » rejoué ne compte qu'une fois par clé, sur un
 * vrai PostgreSQL **et** un vrai Redis.
 *
 * Ce qu'aucun mock ne prouve : l'atomicité de `SET NX` face à deux requêtes
 * simultanées portant la même clé (le rejeu réseau arrive pendant que la
 * première est encore en transaction), et l'incrément SQL réellement appliqué.
 *
 * Exige `TEST_DATABASE_URL` et `TEST_REDIS_URL` (base et Redis **locaux**) ;
 * sans eux, la suite est sautée. Les clés Redis sont propres à chaque test et
 * supprimées ensuite.
 */
const DATABASE_URL = process.env.TEST_DATABASE_URL;
const REDIS_URL = process.env.TEST_REDIS_URL;
const describeIfInfra = DATABASE_URL && REDIS_URL ? describe : describe.skip;

describeIfInfra(
  'ADM-01 — idempotence de RESTOCK (PostgreSQL + Redis réels)',
  () => {
    let prisma: PrismaClient;
    let redis: Redis;
    let service: ProductCommandService;

    beforeAll(async () => {
      prisma = new PrismaClient({
        adapter: new PrismaPg({ connectionString: DATABASE_URL }),
      });
      await prisma.$connect();
      redis = new Redis(REDIS_URL!);
      service = new ProductCommandService(
        prisma as never,
        {} as never,
        {} as never,
        { record: jest.fn() } as never,
        { emit: jest.fn() } as never,
        {} as never,
        {
          get: (k: string) => (k === 'REDIS_URL' ? REDIS_URL : undefined),
        } as never,
        redis,
      );
    });

    afterAll(async () => {
      const keys = await redis.keys('stock:restock:u1:vin:*');
      if (keys.length) await redis.del(...keys);
      await redis.quit();
      await prisma.$disconnect();
    });

    beforeEach(async () => {
      await prisma.$executeRawUnsafe(`
      TRUNCATE TABLE "OrderItem", "OrderHistory", "Order", "CartItem", "Cart",
                     "MenuProduct", "MenuDuJour", "ProductVariant", "Product",
                     "Restaurant", "User"
      RESTART IDENTITY CASCADE
    `);
      await prisma.user.create({
        data: {
          id: 'u1',
          firebaseUid: 'fb-u1',
          email: 'u1@test.local',
          role: 'RESTAURATEUR',
        },
      });
      await prisma.restaurant.create({
        data: {
          id: 'bar',
          nom: 'Bar',
          adresse: 'Poto-Poto',
          phone: '060000071',
          ownerId: 'u1',
        },
      });
      await prisma.product.create({
        data: {
          id: 'vin',
          nom: 'Vin',
          prixOriginal: 13000,
          restaurantId: 'bar',
          stockPolicy: 'INVENTORY',
          stockQuotidien: 5,
          stockRestant: 5,
        },
      });
    });

    const restant = async () =>
      (await prisma.product.findUniqueOrThrow({ where: { id: 'vin' } }))
        .stockRestant;
    const restock = { action: 'RESTOCK' as const, units: 10 };

    it('même clé rejouée après succès : +10 une seule fois', async () => {
      const key = `stock-vin-${randomUUID()}`;

      await service.updateStock('vin', restock, 'fb-u1', key);
      const replay = await service.updateStock('vin', restock, 'fb-u1', key);

      expect(await restant()).toBe(15);
      expect(replay).toMatchObject({ replayed: true });
    });

    it('même clé, deux requêtes simultanées : un seul incrément, l’autre est refusée ou rejouée', async () => {
      const key = `stock-vin-${randomUUID()}`;

      const results = await Promise.allSettled([
        service.updateStock('vin', restock, 'fb-u1', key),
        service.updateStock('vin', restock, 'fb-u1', key),
      ]);

      expect(await restant()).toBe(15);
      expect(
        results.filter((r) => r.status === 'fulfilled').length,
      ).toBeGreaterThanOrEqual(1);
    });

    it('deux gestes distincts (clés différentes) : +10 puis +10', async () => {
      await service.updateStock(
        'vin',
        restock,
        'fb-u1',
        `stock-vin-${randomUUID()}`,
      );
      await service.updateStock(
        'vin',
        restock,
        'fb-u1',
        `stock-vin-${randomUUID()}`,
      );

      expect(await restant()).toBe(25);
    });

    it('sans clé (applications installées) : comportement inchangé, chaque appel compte', async () => {
      await service.updateStock('vin', restock, 'fb-u1');
      await service.updateStock('vin', restock, 'fb-u1');

      expect(await restant()).toBe(25);
    });
  },
);
