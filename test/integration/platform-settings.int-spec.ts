import { ConflictException, BadRequestException } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

import { PlatformSettingsService } from '../../apps/lilia-app/src/modules/platform-settings/platform-settings.service';
import { PrismaService } from '../../apps/lilia-app/src/prisma/prisma.service';

/**
 * Configuration plateforme sous concurrence réelle (SET-001, SET-002).
 *
 * Le verrou optimiste repose sur `UPDATE … WHERE "updatedAt" = <lu>` : seule
 * la base peut prouver que deux écritures parallèles ne passent pas toutes les
 * deux, et que `@updatedAt` avance bien sur un `updateMany` — si ce n'était
 * pas le cas, le verrou ne verrouillerait rien.
 *
 * Deux instances du service simulent deux instances du serveur (chacune son
 * cache de 60 s), comme en production.
 *
 * Se saute proprement sans `TEST_DATABASE_URL`.
 */
const DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

describeIfDb('PlatformSettings — verrou optimiste (PostgreSQL réel)', () => {
  let prisma: PrismaClient;
  let instanceA: PlatformSettingsService;
  let instanceB: PlatformSettingsService;

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
    await prisma.platformSettings.create({
      data: {
        id: 'singleton',
        serviceFeePercent: 15,
        minAppVersion: '1.3.0',
        latestAppVersion: '1.3.0',
      },
    });
    instanceA = new PlatformSettingsService(prisma as unknown as PrismaService);
    instanceB = new PlatformSettingsService(prisma as unknown as PrismaService);
  });

  it('GET A, GET B, PATCH B, PATCH A périmé → 409, et la valeur de B survit', async () => {
    const seenByA = await instanceA.getSettings();
    const seenByB = await instanceB.getSettings();

    // B pose un blocage de sécurité.
    await instanceB.updateSettings({
      latestAppVersion: '1.4.0',
      minAppVersion: '1.4.0',
      expectedUpdatedAt: seenByB.updatedAt.toISOString(),
    });

    // A enregistre son formulaire périmé : il effacerait le blocage.
    await expect(
      instanceA.updateSettings({
        serviceFeePercent: 12,
        minAppVersion: null,
        expectedUpdatedAt: seenByA.updatedAt.toISOString(),
      }),
    ).rejects.toBeInstanceOf(ConflictException);

    const row = await prisma.platformSettings.findUniqueOrThrow({
      where: { id: 'singleton' },
    });
    expect(row.minAppVersion).toBe('1.4.0');
    expect(row.serviceFeePercent).toBe(15);
  });

  it('updateMany fait avancer updatedAt — sans quoi le verrou ne verrouille rien', async () => {
    const before = await instanceA.getSettings();
    await new Promise((r) => setTimeout(r, 5));
    const { after } = await instanceA.updateSettings({ serviceFeePercent: 12 });
    expect(after.updatedAt.getTime()).toBeGreaterThan(
      before.updatedAt.getTime(),
    );
  });

  it('deux PATCH parallèles sur le même état : un seul passe', async () => {
    const seen = await instanceA.getSettings();
    const expectedUpdatedAt = seen.updatedAt.toISOString();

    const results = await Promise.allSettled([
      instanceA.updateSettings({ serviceFeePercent: 11, expectedUpdatedAt }),
      instanceB.updateSettings({ serviceFeePercent: 13, expectedUpdatedAt }),
    ]);

    const ok = results.filter((r) => r.status === 'fulfilled');
    const conflicts = results.filter(
      (r) => r.status === 'rejected' && r.reason instanceof ConflictException,
    );
    expect(ok).toHaveLength(1);
    expect(conflicts).toHaveLength(1);
  });

  it("l'instance qui écrit sert la nouvelle valeur immédiatement", async () => {
    await instanceA.getSettings();
    await instanceA.updateSettings({ maintenanceMode: true });
    expect((await instanceA.getSettings()).maintenanceMode).toBe(true);
  });

  it('PATCH partiel incohérent avec la base → 400, rien n’est écrit', async () => {
    await expect(
      instanceA.updateSettings({ minAppVersion: '2.0.0' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    const row = await prisma.platformSettings.findUniqueOrThrow({
      where: { id: 'singleton' },
    });
    expect(row.minAppVersion).toBe('1.3.0');
  });

  it('lever le blocage passe sans condition supplémentaire', async () => {
    const { after } = await instanceA.updateSettings({ minAppVersion: null });
    expect(after.minAppVersion).toBeNull();
  });
});
