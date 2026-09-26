import { PrismaPg } from '@prisma/adapter-pg';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaClient } from '@prisma/client';

import {
  CheckoutResult,
  OrderCheckoutService,
} from '../../apps/lilia-app/src/modules/orders/order-checkout.service';
import { OrderValidatorService } from '../../apps/lilia-app/src/modules/orders/order-validator.service';
import { OrderCalculatorService } from '../../apps/lilia-app/src/modules/orders/order-calculator.service';
import { StockService } from '../../apps/lilia-app/src/modules/orders/stock.service';
import { PreorderValidatorService } from '../../apps/lilia-app/src/modules/vendors/preorder-validator.service';
import { PromoService } from '../../apps/lilia-app/src/modules/promo/promo.service';
import { OutboxService } from '../../apps/lilia-app/src/modules/outbox/outbox.service';
import { VENDOR_OFFER_NOTICE_EVENT } from '../../apps/lilia-app/src/modules/outbox/outbox-events';
import { computePayoutBreakdown } from '../../apps/lilia-app/src/modules/payments/money.util';
import {
  releaseVendorOfferForOrder,
  VendorOffersService,
} from '../../apps/lilia-app/src/modules/vendor-offers/vendor-offers.service';

/**
 * F3-11 — offres boutique financées par le vendeur, sur PostgreSQL réel.
 *
 * Ce que ces tests prouvent et qu'un mock ne peut pas prouver :
 *  - le budget n'est jamais dépassé, même sous 20 checkouts simultanés
 *    (`UPDATE … WHERE spentXaf + x ≤ budgetXaf`) ;
 *  - une seule offre active par vendeur (index unique partiel) ;
 *  - les termes d'une offre qui a servi sont immuables (déclencheur) ;
 *  - les bornes vendeur tiennent en base (CHECK) ;
 *  - D8 : la commission ne bouge pas avec l'offre, le reversement la retient.
 *
 * Panier de référence : 1 × Poulet à 5 000, retrait au comptoir, frais de
 * service 15 %, commission 10 %.
 */
const DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

describeIfDb('F3-11 — offres boutique (PostgreSQL réel)', () => {
  let prisma: PrismaClient;
  let offers: VendorOffersService;
  let checkout: OrderCheckoutService;
  const events = new EventEmitter2();

  const settings = {
    vendorOffersEnabled: true,
    modifiersEnabled: false,
    serviceFeePercent: 15,
    restaurantCommissionPercent: 10,
    deliveryPricingMode: 'VENDOR_LEGACY',
    loyaltyMinRedemption: 100,
    loyaltyPointValueXaf: 50,
  };
  const settingsService = { getSettings: async () => settings };

  const OWNER = { id: 'vo-owner', fb: 'fb-vo-o' };
  const VENDOR = 'vo-vendor';
  const CLIENTS = Array.from({ length: 20 }, (_, i) => ({
    id: `vo-client-${i}`,
    fb: `fb-vo-c-${i}`,
  }));
  const CLIENT = CLIENTS[0];
  const in14Days = () =>
    new Date(Date.now() + 14 * 24 * 3_600_000).toISOString();

  beforeAll(async () => {
    prisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: DATABASE_URL }),
    });
    await prisma.$connect();

    offers = new VendorOffersService(
      prisma as never,
      settingsService as never,
      new OutboxService(prisma as never),
      { record: async () => undefined } as never,
      events,
    );
    const promo = new PromoService(
      prisma as never,
      {} as never,
      settingsService as never,
      offers,
    );
    checkout = new OrderCheckoutService(
      prisma as never,
      events,
      new OrderValidatorService(
        prisma as never,
        {} as never,
        { decide: async () => ({ open: true }) } as never,
      ),
      new OrderCalculatorService(),
      promo,
      new StockService(),
      { get: () => undefined } as never, // Redis désactivé
      settingsService as never,
      new PreorderValidatorService(prisma as never),
      {} as never, // quartiers — retrait au comptoir
      {} as never, // destination — retrait au comptoir
      {} as never, // tarification plateforme — mode historique
      { recordCreation: async () => undefined } as never,
      { announce: async () => undefined } as never,
      offers,
    );
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    settings.vendorOffersEnabled = true;
    await prisma.$executeRawUnsafe(`
      TRUNCATE TABLE "User", "Restaurant", "Product", "Cart", "Order",
                     "VendorOffer", "PromoCode", "OutboxEvent"
      RESTART IDENTITY CASCADE
    `);
    await prisma.user.createMany({
      data: [
        {
          id: OWNER.id,
          firebaseUid: OWNER.fb,
          email: 'vo-o@t.local',
          role: 'RESTAURATEUR',
        },
        ...CLIENTS.map((c) => ({
          id: c.id,
          firebaseUid: c.fb,
          email: `${c.id}@t.local`,
        })),
      ],
    });
    await prisma.restaurant.create({
      data: {
        id: VENDOR,
        nom: 'Chez Maman',
        adresse: 'Bacongo',
        phone: '060000071',
        ownerId: OWNER.id,
        adminApproved: true,
        isActive: true,
        onboardingStatus: 'ACTIVATED',
        commissionPercent: 10,
      },
    });
    await prisma.product.create({
      data: {
        id: 'p-poulet',
        nom: 'Poulet',
        prixOriginal: 5000,
        restaurantId: VENDOR,
        variants: { create: { id: 'v-poulet', label: 'Standard', prix: 5000 } },
      },
    });
    for (const c of CLIENTS) {
      await prisma.cart.create({
        data: {
          userId: c.id,
          items: {
            create: {
              productId: 'p-poulet',
              variantId: 'v-poulet',
              quantite: 1,
            },
          },
        },
      });
    }
  });

  const publish = (overrides: Record<string, unknown> = {}) =>
    offers.create(OWNER.id, {
      kind: 'PERCENT',
      value: 10,
      endsAt: in14Days(),
      budgetXaf: 20_000,
      ...overrides,
    } as never);

  const placeOrder = (fb = CLIENT.fb, extra: Record<string, unknown> = {}) =>
    checkout.createOrderFromCart(
      fb,
      { paymentMethod: 'MTN_MOMO', isDelivery: false, ...extra } as never,
      `key-${Math.random()}`,
    ) as Promise<CheckoutResult>;

  const codeOf = (p: Promise<unknown>) =>
    p.then(
      () => 'OK',
      (err: {
        response?: { code?: string };
        code?: string;
        message?: string;
      }) => err.response?.code ?? err.code ?? err.message,
    );

  // ─── Checkout ──────────────────────────────────────────────────────────────

  it('applique l’offre, fige la part vendeur ; D8 : commission sur le brut, retenue au reversement', async () => {
    const { data: offer } = await publish();
    const { data: order } = await placeOrder();

    expect(order).toMatchObject({
      subTotal: 5000,
      serviceFee: 750, // 15 % du brut, inchangé
      commissionAmount: 500, // 10 % du brut (D8)
      discountAmount: 500,
      vendorFundedDiscountXaf: 500,
      vendorOfferId: offer.id,
      total: 5000 + 750 - 500,
    });

    const redemption = await prisma.vendorOfferRedemption.findUniqueOrThrow({
      where: { orderId: order.id },
    });
    expect(redemption.discountXaf).toBe(500);
    const fresh = await prisma.vendorOffer.findUniqueOrThrow({
      where: { id: offer.id },
    });
    expect(fresh.spentXaf).toBe(500);

    const payout = computePayoutBreakdown({
      subTotalXaf: order.subTotal,
      commissionPercent: order.commissionPercent,
      vendorOfferDiscountXaf: order.vendorFundedDiscountXaf,
    });
    expect(payout).toMatchObject({
      commissionAmount: 500,
      vendorOfferAmount: 500,
      payoutAmount: 4000,
    });
  });

  it('le devis donne exactement le total du checkout, sans rien écrire', async () => {
    await publish();
    const { data: quote } = await checkout.quote(CLIENT.fb, {
      isDelivery: false,
    } as never);
    expect(quote).toMatchObject({
      subTotal: 5000,
      serviceFee: 750,
      vendorOffer: { discountXaf: 500 },
      total: 5250,
    });
    expect(await prisma.order.count()).toBe(0);
    expect(await prisma.vendorOfferRedemption.count()).toBe(0);

    const { data: order } = await placeOrder(CLIENT.fb, {
      vendorOfferId: quote.vendorOffer!.id,
    });
    expect(order.total).toBe(quote.total);
  });

  it('devis de livraison sur un quartier (adresse pas encore enregistrée) ; le checkout, lui, exige une adresse', async () => {
    await publish();
    await prisma.restaurant.update({
      where: { id: VENDOR },
      data: { fixedDeliveryFee: 1000 },
    });
    const { data: quote } = await checkout.quote(CLIENT.fb, {
      isDelivery: true,
      quartierId: 'q-bacongo',
    } as never);
    expect(quote).toMatchObject({
      deliveryFee: 1000,
      total: 5000 + 1000 + 750 - 500,
    });
    expect(await codeOf(placeOrder(CLIENT.fb, { isDelivery: true }))).toMatch(
      /adresse de livraison est requise/,
    );
    expect(await prisma.order.count()).toBe(0);
  });

  it('interrupteur éteint : aucune offre appliquée', async () => {
    await publish();
    settings.vendorOffersEnabled = false;
    const { data: order } = await placeOrder();
    expect(order.vendorFundedDiscountXaf).toBe(0);
    expect(order.total).toBe(5750);
  });

  it('offre différente de celle du devis → 409, rien n’est écrit', async () => {
    await publish();
    expect(await codeOf(placeOrder(CLIENT.fb, { vendorOfferId: null }))).toBe(
      'VENDOR_OFFER_CHANGED',
    );
    expect(await prisma.order.count()).toBe(0);
  });

  it('offre mise en pause après le devis → 409', async () => {
    const { data: offer } = await publish();
    await offers.update(OWNER.id, offer.id, 'PAUSE');
    expect(
      await codeOf(placeOrder(CLIENT.fb, { vendorOfferId: offer.id })),
    ).toBe('VENDOR_OFFER_CHANGED');
  });

  it('20 checkouts simultanés sur un budget de 4 remises : jamais dépassé', async () => {
    const { data: offer } = await publish({ budgetXaf: 2000 });
    const results = await Promise.all(
      CLIENTS.map((c) => codeOf(placeOrder(c.fb, { vendorOfferId: offer.id }))),
    );
    const fresh = await prisma.vendorOffer.findUniqueOrThrow({
      where: { id: offer.id },
    });
    expect(fresh.spentXaf).toBeLessThanOrEqual(fresh.budgetXaf);
    expect(fresh.spentXaf).toBe(
      (
        await prisma.vendorOfferRedemption.aggregate({
          _sum: { discountXaf: true },
        })
      )._sum.discountXaf,
    );
    expect(results.filter((r) => r === 'OK')).toHaveLength(4);
    expect(
      results
        .filter((r) => r !== 'OK')
        .every((r) => r === 'VENDOR_OFFER_CHANGED'),
    ).toBe(true);
    expect(fresh.status).toBe('EXHAUSTED');

    const notices = await prisma.outboxEvent.findMany({
      where: { type: VENDOR_OFFER_NOTICE_EVENT },
    });
    const kinds = notices.map((n) => (n.payload as { notice: string }).notice);
    // 75 % → 100 % d'un coup : l'avis « épuisé » suffit, pas d'alerte 80 %.
    expect(kinds).toEqual(['EXHAUSTED']);
  });

  it('alerte « budget à 80 % » envoyée une seule fois', async () => {
    await publish({ budgetXaf: 2500 });
    for (const c of CLIENTS.slice(0, 4)) await placeOrder(c.fb); // 2 000 / 2 500
    await placeOrder(CLIENTS[4].fb); // 2 500 : épuisé
    const kinds = (
      await prisma.outboxEvent.findMany({
        where: { type: VENDOR_OFFER_NOTICE_EVENT },
        orderBy: { createdAt: 'asc' },
      })
    ).map((n) => (n.payload as { notice: string }).notice);
    expect(kinds).toEqual(['BUDGET_WARNING', 'EXHAUSTED']);
  });

  it('dernière commande : la remise est ramenée au budget restant', async () => {
    await publish({ budgetXaf: 700 });
    const first = await placeOrder(CLIENTS[0].fb);
    const second = await placeOrder(CLIENTS[1].fb);
    expect(first.data.vendorFundedDiscountXaf).toBe(500);
    expect(second.data.vendorFundedDiscountXaf).toBe(200);
  });

  it('annulation : le budget revient, une seule fois', async () => {
    const { data: offer } = await publish();
    const { data: order } = await placeOrder();
    const release = () =>
      prisma.$transaction((tx) => releaseVendorOfferForOrder(tx, order.id));
    expect(await release()).toBe(500);
    expect(await release()).toBe(0);
    const fresh = await prisma.vendorOffer.findUniqueOrThrow({
      where: { id: offer.id },
    });
    expect(fresh.spentXaf).toBe(0);
    expect(await prisma.vendorOfferRedemption.count()).toBe(0);
  });

  // ─── Codes promo (Q4) ──────────────────────────────────────────────────────

  it('code plateforme non cumulable → refusé ; cumulable → calculé après l’offre', async () => {
    await publish();
    await prisma.promoCode.create({
      data: { code: 'SOLO', discountType: 'PERCENT', discountValue: 10 },
    });
    await prisma.promoCode.create({
      data: {
        code: 'DUO',
        discountType: 'PERCENT',
        discountValue: 10,
        stackableWithVendorOffer: true,
      },
    });
    expect(await codeOf(placeOrder(CLIENT.fb, { promoCode: 'SOLO' }))).toBe(
      'PROMO_NOT_STACKABLE',
    );
    const { data: order } = await placeOrder(CLIENT.fb, { promoCode: 'DUO' });
    // Offre 500, puis 10 % de 4 500 = 450.
    expect(order.discountAmount).toBe(950);
    expect(order.vendorFundedDiscountXaf).toBe(500);
    expect(order.total).toBe(5000 + 750 - 950);
  });

  // ─── Base de données ───────────────────────────────────────────────────────

  it('une seule offre active par vendeur', async () => {
    await publish();
    expect(await codeOf(publish())).toBe('OFFER_ALREADY_ACTIVE');
  });

  it('les bornes tiennent en base, même sans le service', async () => {
    await expect(
      prisma.vendorOffer.create({
        data: {
          restaurantId: VENDOR,
          kind: 'PERCENT',
          value: 60,
          endsAt: new Date(in14Days()),
          budgetXaf: 1000,
          createdBy: OWNER.id,
        },
      }),
    ).rejects.toThrow(/VendorOffer_terms_valid/);
    await expect(
      prisma.vendorOffer.create({
        data: {
          restaurantId: VENDOR,
          kind: 'PERCENT',
          value: 10,
          endsAt: new Date(Date.now() + 40 * 24 * 3_600_000),
          budgetXaf: 1000,
          createdBy: OWNER.id,
        },
      }),
    ).rejects.toThrow(/VendorOffer_window_valid/);
  });

  it('les termes d’une offre qui a servi sont immuables ; le statut, non', async () => {
    const { data: offer } = await publish();
    await prisma.vendorOffer.update({
      where: { id: offer.id },
      data: { value: 15 },
    }); // pas encore servie : permis
    await placeOrder();
    await expect(
      prisma.vendorOffer.update({
        where: { id: offer.id },
        data: { value: 20 },
      }),
    ).rejects.toThrow(/immuables/);
    await offers.update(OWNER.id, offer.id, 'END');
    expect(
      (await prisma.vendorOffer.findUniqueOrThrow({ where: { id: offer.id } }))
        .status,
    ).toBe('ENDED');
  });

  it('commande sans offre : la contrainte de cohérence refuse une part vendeur orpheline', async () => {
    const { data: order } = await placeOrder();
    await expect(
      prisma.order.update({
        where: { id: order.id },
        data: { vendorFundedDiscountXaf: 100 },
      }),
    ).rejects.toThrow(/Order_vendor_offer_consistent/);
  });

  it('échéance : le cron termine l’offre et prévient le vendeur', async () => {
    const { data: offer } = await publish();
    const ended = await offers.endExpired(
      new Date(Date.now() + 15 * 24 * 3_600_000),
    );
    expect(ended).toBe(1);
    expect(
      (await prisma.vendorOffer.findUniqueOrThrow({ where: { id: offer.id } }))
        .status,
    ).toBe('ENDED');
    expect(
      await prisma.outboxEvent.count({
        where: { type: VENDOR_OFFER_NOTICE_EVENT },
      }),
    ).toBe(1);
  });
});
