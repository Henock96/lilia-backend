import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

import { ReviewsService } from '../../apps/lilia-app/src/modules/reviews/reviews.service';
import { BannersService } from '../../apps/lilia-app/src/modules/banners/banners.service';
import { REVIEW_PUBLIC_FORBIDDEN_KEYS } from '../../apps/lilia-app/src/modules/reviews/review-public-projection';

/**
 * F-30 / F-31 (audit du 28/10/2026) — ce que les routes publiques d'avis et
 * de bannières rendent réellement, sur PostgreSQL réel : la réponse entière
 * est parcourue, à toute profondeur, à la recherche d'une clé interdite.
 */
const DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

function keysDeep(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((v) => keysDeep(v, out));
  else if (value && typeof value === 'object' && !(value instanceof Date)) {
    for (const [k, v] of Object.entries(value)) {
      out.add(k);
      keysDeep(v, out);
    }
  }
  return out;
}

describeIfDb(
  'Projections publiques — avis et bannières (PostgreSQL réel)',
  () => {
    let prisma: PrismaClient;
    let reviews: ReviewsService;
    let banners: BannersService;

    beforeAll(async () => {
      prisma = new PrismaClient({
        adapter: new PrismaPg({ connectionString: DATABASE_URL }),
      });
      await prisma.$connect();
      await prisma.$executeRawUnsafe(
        `TRUNCATE TABLE "Review", "Banner", "Restaurant", "User" RESTART IDENTITY CASCADE`,
      );
      await prisma.user.createMany({
        data: [
          {
            id: 'pp-owner',
            firebaseUid: 'fb-pp-o',
            email: 'pp-o@test.local',
            role: 'RESTAURATEUR',
          },
          {
            id: 'pp-client',
            firebaseUid: 'fb-pp-c',
            email: 'pp-c@test.local',
            phone: '061234567',
            nom: 'Awa',
          },
        ],
      });
      await prisma.restaurant.create({
        data: {
          id: 'pp-shop',
          nom: 'Chez Projection',
          adresse: 'Bacongo',
          phone: '060000060',
          ownerId: 'pp-owner',
          isActive: true,
          adminApproved: true,
          onboardingStatus: 'ACTIVATED',
        },
      });
      await prisma.review.create({
        data: {
          id: 'pp-review',
          rating: 5,
          comment: 'Très bon',
          userId: 'pp-client',
          restaurantId: 'pp-shop',
        },
      });
      await prisma.banner.createMany({
        data: [
          { id: 'pp-banner-on', imageUrl: 'https://img/1.jpg', isActive: true },
          {
            id: 'pp-banner-off',
            imageUrl: 'https://img/2.jpg',
            isActive: false,
          },
        ],
      });
      reviews = new ReviewsService(prisma as never);
      banners = new BannersService(prisma as never);
    });

    afterAll(async () => {
      await prisma.$disconnect();
    });

    it.each([
      ['liste', () => reviews.findByRestaurant('pp-shop')],
      ['détail', () => reviews.findOne('pp-review')],
    ])(
      'avis (%s) : aucune clé interdite, ni identifiant client',
      async (_l, call) => {
        const res = await call();
        const keys = keysDeep(res.data);
        for (const forbidden of REVIEW_PUBLIC_FORBIDDEN_KEYS) {
          expect(keys.has(forbidden)).toBe(false);
        }
        expect(JSON.stringify(res.data)).not.toContain('pp-client');
        expect(JSON.stringify(res.data)).toContain('Awa');
      },
    );

    it('bannière inactive : introuvable par identifiant', async () => {
      await expect(banners.findOne('pp-banner-off')).rejects.toThrow(
        'Bannière non trouvée',
      );
      await expect(banners.findOne('pp-banner-on')).resolves.toBeDefined();
    });
  },
);
