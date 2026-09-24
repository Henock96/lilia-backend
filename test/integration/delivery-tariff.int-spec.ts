import { PrismaPg } from '@prisma/adapter-pg';
import { ConflictException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

import { DeliveryTariffsService } from '../../apps/lilia-app/src/modules/delivery-pricing/delivery-tariffs.service';
import { DeliveryPricingService } from '../../apps/lilia-app/src/modules/delivery-pricing/delivery-pricing.service';

/**
 * **F3-02 — grille de livraison plateforme, sur PostgreSQL réel.**
 *
 * Deux garanties que seul PostgreSQL peut apporter :
 *
 *  1. **Au plus une grille publiée.** C'est l'index unique partiel
 *     `DeliveryTariff_one_published_uq` qui l'assure, pas le service : deux
 *     publications simultanées lisent chacune « la » grille en vigueur, la
 *     retirent, puis publient la leur. Sans l'index, en READ COMMITTED, la
 *     seconde ne voit pas la grille que la première vient de publier — et on
 *     finit avec deux grilles en vigueur, c'est-à-dire deux prix pour la même
 *     course.
 *  2. **La subvention ne dépasse jamais le prix de base** (CHECK sur `Order`).
 *
 * Et une troisième, de bout en bout : le devis lu en base par le service est
 * celui de la grille publiée.
 */
const DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

describeIfDb('Grille de livraison — PostgreSQL réel', () => {
  let prisma: PrismaClient;
  let tariffs: DeliveryTariffsService;
  const ADMIN = 'dt-admin';

  const draft = (fee: number) => ({
    roadFactor: 1.3,
    bands: [
      { maxKm: 3, feeXaf: fee },
      { maxKm: 6, feeXaf: fee + 500 },
    ],
  });

  beforeAll(async () => {
    prisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: DATABASE_URL }),
    });
    await prisma.$connect();
    tariffs = new DeliveryTariffsService(prisma as never);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(`
      TRUNCATE TABLE "DeliveryTariffOverride", "DeliveryTariffBand",
                     "DeliveryTariff", "AdminAuditLog", "User"
      RESTART IDENTITY CASCADE
    `);
    await prisma.user.create({
      data: {
        id: ADMIN,
        firebaseUid: 'fb-dt-admin',
        email: 'dt-admin@test.local',
        role: 'ADMIN',
      },
    });
  });

  it('publier une nouvelle grille retire l’ancienne, et laisse une trace', async () => {
    const v1 = await tariffs.createDraft(draft(1000), ADMIN);
    await tariffs.publish(v1.id, ADMIN);
    const v2 = await tariffs.createDraft(draft(1200), ADMIN);
    await tariffs.publish(v2.id, ADMIN);

    const rows = await prisma.deliveryTariff.findMany({
      orderBy: { version: 'asc' },
      select: { version: true, status: true },
    });
    expect(rows).toEqual([
      { version: 1, status: 'RETIRED' },
      { version: 2, status: 'PUBLISHED' },
    ]);
    expect(
      await prisma.adminAuditLog.count({
        where: { action: 'DELIVERY_TARIFF_PUBLISHED' },
      }),
    ).toBe(2);
  });

  it('deux publications simultanées : une seule grille en vigueur, l’autre reçoit 409', async () => {
    const v1 = await tariffs.createDraft(draft(1000), ADMIN);
    await tariffs.publish(v1.id, ADMIN);
    const a = await tariffs.createDraft(draft(1100), ADMIN);
    const b = await tariffs.createDraft(draft(1300), ADMIN);

    const results = await Promise.allSettled([
      tariffs.publish(a.id, ADMIN),
      tariffs.publish(b.id, ADMIN),
    ]);

    const published = await prisma.deliveryTariff.count({
      where: { status: 'PUBLISHED' },
    });
    expect(published).toBe(1);

    const rejected = results.filter((r) => r.status === 'rejected');
    // Selon l'ordonnancement, les deux peuvent réussir l'une après l'autre
    // (la seconde retire alors la première) — jamais coexister.
    for (const r of rejected) {
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(
        ConflictException,
      );
    }
    // Chaque publication qui a réussi a laissé sa trace, et seulement elle.
    expect(
      await prisma.adminAuditLog.count({
        where: { action: 'DELIVERY_TARIFF_PUBLISHED' },
      }),
    ).toBe(1 + results.filter((r) => r.status === 'fulfilled').length);
  });

  it('la base refuse deux grilles publiées, même hors du service', async () => {
    const a = await tariffs.createDraft(draft(1000), ADMIN);
    const b = await tariffs.createDraft(draft(1100), ADMIN);
    await prisma.deliveryTariff.update({
      where: { id: a.id },
      data: { status: 'PUBLISHED' },
    });
    await expect(
      prisma.deliveryTariff.update({
        where: { id: b.id },
        data: { status: 'PUBLISHED' },
      }),
    ).rejects.toThrow();
  });

  it('une grille publiée ne se modifie plus', async () => {
    const v1 = await tariffs.createDraft(draft(1000), ADMIN);
    await tariffs.publish(v1.id, ADMIN);
    await expect(tariffs.updateDraft(v1.id, draft(5000))).rejects.toThrow(
      ConflictException,
    );
    const bands = await prisma.deliveryTariffBand.findMany({
      where: { tariffId: v1.id },
      orderBy: { maxKm: 'asc' },
    });
    expect(bands.map((b) => b.feeXaf)).toEqual([1000, 1500]);
  });

  it('le devis lit la grille PUBLIÉE en base, pas un brouillon plus récent', async () => {
    const v1 = await tariffs.createDraft(draft(1000), ADMIN);
    await tariffs.publish(v1.id, ADMIN);
    await tariffs.createDraft(draft(9000), ADMIN); // brouillon, jamais publié

    const pricing = new DeliveryPricingService(
      prisma as never,
      {
        getSettings: async () => ({ deliveryPricingMode: 'PLATFORM' }),
      } as never,
    );
    const quote = await pricing.quoteForVendor({
      vendor: {
        id: 'v',
        latitude: -4.2634,
        longitude: 15.2729,
        quartierId: null,
        deliverySubsidyMode: 'FIXED',
        deliverySubsidyXaf: 400,
        freeDeliveryThresholdXaf: null,
      },
      destination: { quartierId: null, latitude: -4.2454, longitude: 15.2629 },
      subTotalXaf: 5000,
    });
    expect(quote).toMatchObject({
      tariffVersion: 1,
      baseFeeXaf: 1000,
      subsidyXaf: 400,
      customerFeeXaf: 600,
    });
  });

  it('CHECK : une subvention supérieure au prix de base est refusée par la base', async () => {
    const check = await prisma.$queryRawUnsafe<{ def: string }[]>(`
      SELECT pg_get_constraintdef(oid) AS def
        FROM pg_constraint
       WHERE conname = 'Order_delivery_subsidy_bounds'
    `);
    expect(check).toHaveLength(1);
    expect(check[0].def).toMatch(
      /"vendorDeliverySubsidyXaf" <= "deliveryFeeBaseXaf"/,
    );
  });
});
