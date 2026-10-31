import { randomUUID } from 'crypto';

import { PrismaPg } from '@prisma/adapter-pg';
import { ConflictException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

import { ProductCommandService } from '../../apps/lilia-app/src/modules/products/product-command.service';

/**
 * ADM-01 — « Réapprovisionner +N » rejoué ne compte qu'une fois par clé, sur un
 * vrai PostgreSQL.
 *
 * Durcissement lot 4 : la clé est un reçu `IdempotencyReceipt` écrit dans la
 * transaction du geste, et non plus une clé Redis. Ce qu'aucun mock ne prouve :
 * deux requêtes simultanées portant la même clé (le rejeu réseau arrive pendant
 * que la première est encore en transaction) se sérialisent sur la clé
 * primaire, et l'incrément SQL n'est appliqué qu'une fois.
 */
const DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

describeIfDb('ADM-01 — idempotence de RESTOCK (PostgreSQL réel)', () => {
  let prisma: PrismaClient;
  let service: ProductCommandService;

  beforeAll(async () => {
    prisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: DATABASE_URL }),
    });
    await prisma.$connect();
    service = new ProductCommandService(
      prisma as never,
      {} as never,
      {} as never,
      { record: jest.fn() } as never,
      { emit: jest.fn() } as never,
      {} as never,
    );
  });

  afterAll(async () => {
    await prisma.idempotencyReceipt.deleteMany({ where: { ownerId: 'u1' } });
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(`
      TRUNCATE TABLE "OrderItem", "OrderHistory", "Order", "CartItem", "Cart",
                     "MenuProduct", "MenuDuJour", "ProductVariant", "Product",
                     "Restaurant", "User", "IdempotencyReceipt"
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
    expect(replay).toMatchObject({
      replayed: true,
      data: { stockRestant: 15 },
    });
  });

  it('même clé ×5 simultanées : un seul incrément, toutes reçoivent l’état final', async () => {
    const key = `stock-vin-${randomUUID()}`;

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        service.updateStock('vin', restock, 'fb-u1', key),
      ),
    );

    expect(await restant()).toBe(15);
    expect(results.filter((r) => 'replayed' in r && r.replayed)).toHaveLength(
      4,
    );
    expect(await prisma.idempotencyReceipt.count()).toBe(1);
  });

  it('même clé pour une autre quantité : 409, rien n’est ajouté', async () => {
    const key = `stock-vin-${randomUUID()}`;
    await service.updateStock('vin', restock, 'fb-u1', key);

    await expect(
      service.updateStock('vin', { action: 'RESTOCK', units: 3 }, 'fb-u1', key),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(await restant()).toBe(15);
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

  it('geste refusé (produit illimité) : aucun reçu, la clé reste libre', async () => {
    await prisma.product.update({
      where: { id: 'vin' },
      data: {
        stockPolicy: 'UNLIMITED',
        stockRestant: null,
        stockQuotidien: null,
      },
    });

    await expect(
      service.updateStock('vin', restock, 'fb-u1', 'stock-vin-refuse'),
    ).rejects.toBeDefined();
    expect(await prisma.idempotencyReceipt.count()).toBe(0);
  });

  it('sans clé (applications installées) : comportement inchangé, chaque appel compte', async () => {
    await service.updateStock('vin', restock, 'fb-u1');
    await service.updateStock('vin', restock, 'fb-u1');

    expect(await restant()).toBe(25);
    expect(await prisma.idempotencyReceipt.count()).toBe(0);
  });
});
