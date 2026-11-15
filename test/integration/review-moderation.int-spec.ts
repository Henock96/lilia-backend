import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

import { ReviewsService } from '../../apps/lilia-app/src/modules/reviews/reviews.service';
import { ReviewModerationService } from '../../apps/lilia-app/src/modules/reviews/review-moderation.service';
import { ratingOf } from '../../apps/lilia-app/src/modules/restaurants/restaurant-ratings';
import { DeliveryReviewsService } from '../../apps/lilia-app/src/modules/delivery-reviews/delivery-reviews.service';

/**
 * Lot B (15/11/2026) — avis par commande, modération et réponse du vendeur,
 * sur PostgreSQL réel (migrations appliquées, CHECK compris).
 */
const DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

describeIfDb('Avis — lot B (PostgreSQL réel)', () => {
  let prisma: PrismaClient;
  let reviews: ReviewsService;
  let moderation: ReviewModerationService;
  let driverReviews: DeliveryReviewsService;

  const SHOP = 'rv-shop';
  const OTHER_SHOP = 'rv-other-shop';

  beforeAll(async () => {
    prisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: DATABASE_URL }),
    });
    await prisma.$connect();
    reviews = new ReviewsService(prisma as never);
    moderation = new ReviewModerationService(prisma as never);
    driverReviews = new DeliveryReviewsService(prisma as never);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(`
      TRUNCATE TABLE "AdminAuditLog", "DeliveryReview", "Review", "Delivery",
        "Order", "ShopMembership", "Restaurant", "User"
      RESTART IDENTITY CASCADE
    `);
    await prisma.user.createMany({
      data: [
        {
          id: 'rv-owner',
          firebaseUid: 'fb-rv-owner',
          email: 'rv-owner@test.local',
          role: 'RESTAURATEUR',
        },
        {
          id: 'rv-other',
          firebaseUid: 'fb-rv-other',
          email: 'rv-other@test.local',
          role: 'RESTAURATEUR',
        },
        {
          id: 'rv-client',
          firebaseUid: 'fb-rv-client',
          email: 'rv-client@test.local',
          nom: 'Awa Mabiala',
        },
        {
          id: 'rv-driver',
          firebaseUid: 'fb-rv-driver',
          email: 'rv-driver@test.local',
          role: 'LIVREUR',
        },
        {
          id: 'rv-admin',
          firebaseUid: 'fb-rv-admin',
          email: 'rv-admin@test.local',
          role: 'ADMIN',
        },
      ],
    });
    for (const [id, ownerId] of [
      [SHOP, 'rv-owner'],
      [OTHER_SHOP, 'rv-other'],
    ]) {
      await prisma.restaurant.create({
        data: {
          id,
          nom: id,
          adresse: 'Bacongo',
          phone: '060000070',
          ownerId,
          isActive: true,
          adminApproved: true,
          onboardingStatus: 'ACTIVATED',
        },
      });
    }
  });

  async function deliveredOrder(id: string, deliveryProof: string) {
    await prisma.order.create({
      data: {
        id,
        restaurantId: SHOP,
        userId: 'rv-client',
        subTotal: 4000,
        deliveryFee: 0,
        deliveryFeeGross: 0,
        total: 4000,
        paymentMethod: 'MTN_MOMO',
        isDelivery: true,
        status: 'LIVRER',
        deliveredAt: new Date(),
        deliveryProof,
        // CHECK `Order_payoutDueAt_needs_proof` : une preuve fiable ouvre
        // l'échéance de versement, une preuve faible l'interdit.
        payoutDueAt: ['DELIVERY_UNVERIFIED'].includes(deliveryProof)
          ? null
          : new Date(Date.now() + 3_600_000),
      },
    });
  }

  const review = (orderId?: string) =>
    reviews.create(
      { rating: 4, comment: 'Bon', restaurantId: SHOP, orderId },
      'fb-rv-client',
    );

  it('un avis par commande livrée prouvée : deux commandes, deux avis ; rejeu → 409', async () => {
    await deliveredOrder('rv-o1', 'DELIVERY_CODE');
    await deliveredOrder('rv-o2', 'DELIVERY_CODE');

    await review('rv-o1');
    await review('rv-o2');
    await expect(review('rv-o1')).rejects.toMatchObject({ status: 409 });
    // Double envoi simultané : la contrainte unique tranche.
    await deliveredOrder('rv-o3', 'DELIVERY_CODE');
    const both = await Promise.allSettled([review('rv-o3'), review('rv-o3')]);
    expect(both.filter((r) => r.status === 'fulfilled')).toHaveLength(1);

    expect(await prisma.review.count({ where: { restaurantId: SHOP } })).toBe(
      3,
    );
  });

  it.each(['DELIVERY_ADMIN_OVERRIDE', 'DELIVERY_UNVERIFIED'])(
    'remise non prouvée (%s) : ni avis rattaché, ni avis général',
    async (proof) => {
      await deliveredOrder('rv-weak', proof);
      await expect(review('rv-weak')).rejects.toMatchObject({ status: 400 });
      await expect(review()).rejects.toMatchObject({ status: 400 });
      expect(await reviews.canReview(SHOP, 'fb-rv-client')).toMatchObject({
        canReview: false,
      });
    },
  );

  it('masquer : sort de la liste publique et des moyennes, audité ; rétablir le ramène', async () => {
    await deliveredOrder('rv-o1', 'DELIVERY_CODE');
    await deliveredOrder('rv-o2', 'DELIVERY_CODE');
    await reviews.create(
      { rating: 1, comment: 'Injure', restaurantId: SHOP, orderId: 'rv-o1' },
      'fb-rv-client',
    );
    await reviews.create(
      { rating: 5, restaurantId: SHOP, orderId: 'rv-o2' },
      'fb-rv-client',
    );
    const insult = await prisma.review.findUniqueOrThrow({
      where: { orderId: 'rv-o1' },
    });

    await moderation.hide('REVIEW', insult.id, 'rv-admin', 'Propos injurieux');

    const pub = await reviews.findByRestaurant(SHOP);
    expect(pub.data.map((r) => r.id)).not.toContain(insult.id);
    expect(pub.meta.total).toBe(1);
    expect(pub.stats).toMatchObject({ averageRating: 5, totalReviews: 1 });
    expect(await ratingOf(prisma, SHOP)).toEqual({
      averageRating: 5,
      totalReviews: 1,
    });
    await expect(reviews.findOne(insult.id)).rejects.toMatchObject({
      status: 404,
    });
    const vendorView = await reviews.listForVendor('rv-owner');
    expect(vendorView.data.map((r) => r.id)).not.toContain(insult.id);

    const audit = await prisma.adminAuditLog.findMany({
      where: { targetId: insult.id },
    });
    expect(audit).toEqual([
      expect.objectContaining({
        action: 'REVIEW_HIDDEN',
        actorId: 'rv-admin',
        reason: 'Propos injurieux',
        targetType: 'Review',
      }),
    ]);

    await moderation.unhide('REVIEW', insult.id, 'rv-admin');
    expect((await reviews.findByRestaurant(SHOP)).meta.total).toBe(2);
    const after = await prisma.review.findUniqueOrThrow({
      where: { id: insult.id },
    });
    expect(after).toMatchObject({
      hiddenAt: null,
      hiddenById: null,
      hiddenReason: null,
    });
  });

  it('deux admins masquent en même temps : un masquage, un 409, une ligne d’audit', async () => {
    await deliveredOrder('rv-o1', 'DELIVERY_CODE');
    await review('rv-o1');
    const { id } = await prisma.review.findUniqueOrThrow({
      where: { orderId: 'rv-o1' },
    });

    const results = await Promise.allSettled([
      moderation.hide('REVIEW', id, 'rv-admin', 'Motif un'),
      moderation.hide('REVIEW', id, 'rv-admin', 'Motif deux'),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected');
    expect((rejected as PromiseRejectedResult).reason).toMatchObject({
      status: 409,
    });
    expect(await prisma.adminAuditLog.count({ where: { targetId: id } })).toBe(
      1,
    );
  });

  it('vendeur : ne lit que ses boutiques, auteur anonyme', async () => {
    await deliveredOrder('rv-commande-7f3a2b', 'DELIVERY_CODE');
    await review('rv-commande-7f3a2b');

    const mine = await reviews.listForVendor('rv-owner');
    expect(mine.data).toHaveLength(1);
    expect(mine.data[0]).toMatchObject({
      author: 'Client',
      orderRef: '7F3A2B',
    });
    const json = JSON.stringify(mine);
    expect(json).not.toContain('rv-client');
    expect(json).not.toContain('Awa');

    expect((await reviews.listForVendor('rv-other')).data).toHaveLength(0);
    await expect(
      reviews.listForVendor('rv-other', { restaurantId: SHOP }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('réponse du vendeur : publique, modifiable, réservée à la boutique, masquable', async () => {
    await deliveredOrder('rv-o1', 'DELIVERY_CODE');
    await review('rv-o1');
    const { id } = await prisma.review.findUniqueOrThrow({
      where: { orderId: 'rv-o1' },
    });

    await expect(
      reviews.replyAsVendor('rv-other', id, 'Pas ma boutique'),
    ).rejects.toMatchObject({ status: 404 });

    await reviews.replyAsVendor('rv-owner', id, 'Merci Awa !');
    await reviews.replyAsVendor('rv-owner', id, '  Merci, à bientôt !  ');
    let pub = await reviews.findByRestaurant(SHOP);
    expect(pub.data[0]).toMatchObject({
      vendorReply: 'Merci, à bientôt !',
      user: { nom: 'Awa M.' },
    });

    await moderation.hide('VENDOR_REPLY', id, 'rv-admin', 'Réponse agressive');
    pub = await reviews.findByRestaurant(SHOP);
    expect(pub.data[0]).toMatchObject({ vendorReply: null });
    expect((await reviews.listForVendor('rv-owner')).data[0]).toMatchObject({
      vendorReplyHidden: true,
    });
    await expect(
      reviews.replyAsVendor('rv-owner', id, 'Je contourne'),
    ).rejects.toMatchObject({ status: 409 });

    await moderation.unhide('VENDOR_REPLY', id, 'rv-admin');
    pub = await reviews.findByRestaurant(SHOP);
    expect(pub.data[0]).toMatchObject({ vendorReply: 'Merci, à bientôt !' });

    // Avis masqué : plus de réponse possible.
    await moderation.hide('REVIEW', id, 'rv-admin', 'Avis frauduleux');
    await expect(
      reviews.replyAsVendor('rv-owner', id, 'Encore moi'),
    ).rejects.toMatchObject({ status: 409 });

    // L'auteur ne réécrit pas un avis masqué, et ne lit pas le motif interne.
    await expect(
      reviews.update(id, { comment: 'Version adoucie' }, 'fb-rv-client'),
    ).rejects.toMatchObject({ status: 409 });
    const mine = await reviews.getUserReview(SHOP, 'fb-rv-client');
    expect(mine.data).not.toHaveProperty('hiddenReason');
    expect(mine.data).not.toHaveProperty('hiddenById');
    expect(JSON.stringify(mine)).not.toContain('Avis frauduleux');
  });

  it('masquer une réponse inexistante : 404', async () => {
    await deliveredOrder('rv-o1', 'DELIVERY_CODE');
    await review('rv-o1');
    const { id } = await prisma.review.findUniqueOrThrow({
      where: { orderId: 'rv-o1' },
    });
    await expect(
      moderation.hide('VENDOR_REPLY', id, 'rv-admin', 'Rien à masquer'),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('CHECK : un masquage sans motif est refusé par la base', async () => {
    await deliveredOrder('rv-o1', 'DELIVERY_CODE');
    await review('rv-o1');
    await expect(
      prisma.review.updateMany({
        where: { orderId: 'rv-o1' },
        data: { hiddenAt: new Date() },
      }),
    ).rejects.toThrow(/Review_moderation_consistent/);
  });

  it('note livreur : remise prouvée exigée ; masquée, elle sort de la moyenne', async () => {
    await deliveredOrder('rv-o1', 'DELIVERY_CODE');
    await deliveredOrder('rv-o2', 'DELIVERY_ADMIN_OVERRIDE');
    for (const orderId of ['rv-o1', 'rv-o2']) {
      await prisma.delivery.create({
        data: {
          id: `d-${orderId}`,
          orderId,
          delivererId: 'rv-driver',
          status: 'LIVRER',
        },
      });
    }

    await expect(
      driverReviews.create(
        { deliveryId: 'd-rv-o2', rating: 1 },
        'fb-rv-client',
      ),
    ).rejects.toMatchObject({ status: 400 });

    const created = await driverReviews.create(
      { deliveryId: 'd-rv-o1', rating: 2 },
      'fb-rv-client',
    );
    expect(
      (await driverReviews.getDelivererStats('rv-driver')).data,
    ).toMatchObject({ totalReviews: 1, averageRating: 2 });

    await moderation.hide(
      'DELIVERY_REVIEW',
      created.data.id,
      'rv-admin',
      'Note de représailles',
    );
    expect(
      (await driverReviews.getDelivererStats('rv-driver')).data,
    ).toMatchObject({ totalReviews: 0, averageRating: null });
    expect((await driverReviews.findMine('fb-rv-driver')).meta.total).toBe(0);
  });
});
