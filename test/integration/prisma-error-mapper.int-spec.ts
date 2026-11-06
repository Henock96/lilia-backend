import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

import { mapPrismaError } from '../../apps/lilia-app/src/common/exception-filters/prisma-error.mapper';

/**
 * Les messages de doublon dépendent de la forme des P2002, que seul un vrai
 * PostgreSQL derrière `@prisma/adapter-pg` peut montrer. Le spec unitaire
 * fabriquait un `meta.target` qui n'existe plus : il restait vert pendant que
 * tous les clients lisaient « Cette valeur existe déjà. ».
 */
const DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

describeIfDb('Messages de doublon (PostgreSQL réel)', () => {
  let prisma: PrismaClient;

  const messageDe = async (ecriture: () => Promise<unknown>) => {
    const erreur = await ecriture().then(
      () => {
        throw new Error('écriture acceptée : aucun doublon');
      },
      (e: unknown) => e,
    );
    return mapPrismaError(erreur)?.message;
  };

  beforeAll(async () => {
    prisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: DATABASE_URL }),
    });
    await prisma.$connect();
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(`
      TRUNCATE TABLE "Favorite", "Restaurant", "User" RESTART IDENTITY CASCADE
    `);
    await prisma.user.create({
      data: { id: 'dup-user', firebaseUid: 'fb-dup', email: 'dup@test.local' },
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('adresse déjà prise sous un autre uid, comme le fait /users/sync', async () => {
    const message = await messageDe(() =>
      prisma.user.upsert({
        where: { firebaseUid: 'fb-autre' },
        create: { firebaseUid: 'fb-autre', email: 'dup@test.local' },
        update: {},
      }),
    );

    expect(message).toBe('Cette adresse e-mail est déjà utilisée.');
  });

  it('colonne à majuscule, citée entre guillemets par PostgreSQL', async () => {
    const message = await messageDe(() =>
      prisma.user.create({
        data: { firebaseUid: 'fb-dup', email: 'autre@test.local' },
      }),
    );

    expect(message).toBe('Ce compte existe déjà.');
  });

  it('contrainte composée', async () => {
    await prisma.restaurant.create({
      data: {
        id: 'dup-vendor',
        nom: 'Chez Doublon',
        adresse: 'Ouenzé',
        phone: '060000051',
        ownerId: 'dup-user',
      },
    });
    const favori = { userId: 'dup-user', restaurantId: 'dup-vendor' };
    await prisma.favorite.create({ data: favori });

    const message = await messageDe(() =>
      prisma.favorite.create({ data: favori }),
    );

    expect(message).toBe('Vous avez déjà enregistré ce vendeur.');
  });
});
