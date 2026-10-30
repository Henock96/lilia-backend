import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

import { VendorReachabilityService } from '../../apps/lilia-app/src/modules/vendors/vendor-reachability.service';

/**
 * F-03 (audit du 28/10/2026) — joignabilité des boutiques, sur PostgreSQL réel.
 *
 * Trois garanties :
 *  - chaque boutique ne compte QUE les appareils de son propre compte ;
 *  - la réponse ne porte ni token FCM ni numéro de téléphone ;
 *  - les boutiques à traiter remontent en tête.
 */
const DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

describeIfDb('Joignabilité des boutiques (PostgreSQL réel)', () => {
  let prisma: PrismaClient;
  let service: VendorReachabilityService;
  const now = new Date('2026-10-29T12:00:00Z');
  const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000);

  beforeAll(async () => {
    prisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: DATABASE_URL }),
    });
    await prisma.$connect();
    await prisma.$executeRawUnsafe(
      `TRUNCATE TABLE "FcmToken", "Restaurant", "User" RESTART IDENTITY CASCADE`,
    );

    const vendor = async (
      key: string,
      opts: { ownerPhone?: string; shopPhone: string; tokens: Date[] },
    ) => {
      await prisma.user.create({
        data: {
          id: `rv-${key}`,
          firebaseUid: `fb-rv-${key}`,
          email: `rv-${key}@test.local`,
          role: 'RESTAURATEUR',
          phone: opts.ownerPhone ?? null,
        },
      });
      await prisma.restaurant.create({
        data: {
          id: `shop-${key}`,
          nom: `Boutique ${key}`,
          adresse: 'Poto-Poto',
          phone: opts.shopPhone,
          ownerId: `rv-${key}`,
        },
      });
      for (const [i, at] of opts.tokens.entries()) {
        await prisma.fcmToken.create({
          data: {
            token: `secret-token-${key}-${i}`,
            userId: `rv-${key}`,
            lastRegisteredAt: at,
          },
        });
      }
    };

    await vendor('ok', {
      ownerPhone: '061112233',
      shopPhone: '0222810000',
      tokens: [daysAgo(1), daysAgo(3)],
    });
    await vendor('sms', { shopPhone: '055554433', tokens: [] });
    await vendor('mute', { shopPhone: '0222810000', tokens: [] });
    await vendor('stale', {
      ownerPhone: '061112244',
      shopPhone: '0222810000',
      tokens: [daysAgo(45)],
    });
    await vendor('nofallback', {
      shopPhone: '0222810000',
      tokens: [daysAgo(2)],
    });

    service = new VendorReachabilityService(prisma as never);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('classe chaque boutique sur ses propres appareils, les plus graves en tête', async () => {
    const rows = await service.list(now);
    const byId = Object.fromEntries(rows.map((r) => [r.restaurantId, r]));

    expect(byId['shop-ok']).toMatchObject({
      deviceCount: 2,
      status: 'OK',
      smsFallback: 'OWNER',
      needsAction: false,
    });
    expect(byId['shop-ok'].lastDeviceRegisteredAt).toBe(
      daysAgo(1).toISOString(),
    );
    expect(byId['shop-sms']).toMatchObject({
      deviceCount: 0,
      status: 'NO_DEVICE',
      smsFallback: 'SHOP',
    });
    expect(byId['shop-mute']).toMatchObject({
      deviceCount: 0,
      status: 'NO_CHANNEL',
      smsFallback: null,
    });
    expect(byId['shop-stale']).toMatchObject({
      deviceCount: 1,
      status: 'STALE_DEVICE',
    });
    expect(byId['shop-nofallback']).toMatchObject({
      deviceCount: 1,
      status: 'NO_SMS_FALLBACK',
    });

    expect(rows[0].status).toBe('NO_CHANNEL');
    expect(rows[rows.length - 1].status).toBe('OK');
  });

  it('ne laisse fuir ni token ni numéro', async () => {
    const json = JSON.stringify(await service.list(now));
    expect(json).not.toMatch(/secret-token/);
    expect(json).not.toMatch(/0611122|0555544|0222810/);
  });
});
