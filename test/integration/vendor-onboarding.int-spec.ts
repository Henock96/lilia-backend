import { PrismaPg } from '@prisma/adapter-pg';
import { OnboardingStatus, PrismaClient, VendorType } from '@prisma/client';

import { VendorReadinessService } from '../../apps/lilia-app/src/modules/vendors/vendor-readiness.service';
import { PUBLIC_VENDOR_WHERE } from '../../apps/lilia-app/src/common/vendor-visibility';

/**
 * Onboarding d'un vendeur, du compte vide à la première commande possible,
 * sur un vrai PostgreSQL.
 *
 * Les tests unitaires de l'onboarding mockent Prisma : ils vérifient qu'un
 * service **appelle** la bonne requête, jamais que l'état résultant permet
 * l'étape suivante — ni surtout que le client voit bien, ou ne voit pas, ce
 * qu'il doit. Or c'est exactement là que se jouait le défaut d'origine : un
 * vendeur créé était immédiatement visible et commandable alors qu'il n'avait
 * ni horaires, ni GPS, ni produit.
 *
 * Ce fichier suit donc **un seul vendeur** sans réinitialiser l'état entre les
 * étapes, et interroge le catalogue exactement comme le fait l'API publique.
 *
 * Se saute proprement sans `TEST_DATABASE_URL`.
 */
const DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

describeIfDb('Onboarding vendeur — du DRAFT à la commande client', () => {
  let prisma: PrismaClient;
  let readiness: VendorReadinessService;

  const VENDOR_ID = 'onb-vendor-1';
  const OWNER_ID = 'onb-owner-1';
  const QUARTIER_ID = 'onb-quartier-1';

  beforeAll(async () => {
    prisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: DATABASE_URL }),
    });
    await prisma.$connect();
    readiness = new VendorReadinessService(prisma as never);

    await prisma.$executeRawUnsafe(`
      TRUNCATE TABLE "DeliveryReview", "DeliveryLocation", "Delivery",
                     "LoyaltyTransaction", "OrderItem", "OrderHistory",
                     "payments", "Refund", "Order", "CartItem", "Cart",
                     "VendorPhoto", "OperatingHours", "Specialty",
                     "VendorProfile", "ProductVariant", "Product",
                     "QuartierZone", "DeliveryZone", "Restaurant",
                     "Quartier", "User"
      RESTART IDENTITY CASCADE
    `);

    await prisma.quartier.create({
      data: { id: QUARTIER_ID, nom: 'Bacongo-Test', ville: 'Brazzaville' },
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  /** Ce que voit réellement un client : même filtre que `GET /vendors`. */
  const visibleToClients = () =>
    prisma.restaurant.findFirst({
      where: { id: VENDOR_ID, ...PUBLIC_VENDOR_WHERE },
    });

  // ─── Étape 1 — création ────────────────────────────────────────────────────

  it('1. crée le vendeur et son propriétaire, en DRAFT et fermé', async () => {
    await prisma.user.create({
      data: {
        id: OWNER_ID,
        firebaseUid: 'fb-onb-owner',
        email: 'boulanger@test.local',
        nom: 'Boulanger Test',
        phone: '060000101',
        role: 'RESTAURATEUR',
      },
    });

    const vendor = await prisma.restaurant.create({
      data: {
        id: VENDOR_ID,
        nom: 'Boulangerie du Test',
        adresse: 'Avenue de la Paix',
        phone: '060000102',
        ownerId: OWNER_ID,
        vendorType: VendorType.RESTAURANT,
        adminApproved: true,
        onboardingStatus: OnboardingStatus.DRAFT,
        isOpen: false,
        operatingHours: {
          create: [
            'LUNDI',
            'MARDI',
            'MERCREDI',
            'JEUDI',
            'VENDREDI',
            'SAMEDI',
            'DIMANCHE',
          ].map((dayOfWeek) => ({
            dayOfWeek: dayOfWeek as never,
            openTime: '08:00',
            closeTime: '20:00',
            isClosed: true,
          })),
        },
      },
    });

    expect(vendor.onboardingStatus).toBe(OnboardingStatus.DRAFT);
    expect(vendor.isOpen).toBe(false);
  });

  it('2. le vendeur en DRAFT est INVISIBLE du catalogue client', async () => {
    // C'est le défaut historique que tout ce chantier corrige : une boutique
    // vide était publiée à la seconde où le formulaire était validé.
    expect(await visibleToClients()).toBeNull();

    const report = await readiness.getReport(VENDOR_ID);
    expect(report!.isReady).toBe(false);
    expect(report!.blockingIssues.length).toBeGreaterThan(0);
  });

  it('3. la checklist énumère précisément ce qui manque', async () => {
    const report = await readiness.getReport(VENDOR_ID);
    const missing = report!.checks
      .filter((c) => c.blocking && c.status !== 'OK')
      .map((c) => c.key)
      .sort();

    expect(missing).toEqual(['catalog', 'gps', 'hours', 'location', 'logo']);
  });

  // ─── Étapes 3 à 8 — configuration ──────────────────────────────────────────

  it('4. logo, description et localisation cochent leurs cases', async () => {
    await prisma.restaurant.update({
      where: { id: VENDOR_ID },
      data: {
        description: 'Pain frais et viennoiseries chaque matin',
        imageUrl: 'https://cdn.test/logo.png',
        imagePublicId: 'lilia-food/restaurants/logo-test',
        quartierId: QUARTIER_ID,
        latitude: -4.2891,
        longitude: 15.2648,
        deliveryInstructions: 'Portail bleu, face à la pharmacie',
      },
    });

    const report = await readiness.getReport(VENDOR_ID);
    expect(report!.checks.find((c) => c.key === 'logo')!.status).toBe('OK');
    expect(report!.checks.find((c) => c.key === 'location')!.status).toBe('OK');
    expect(report!.checks.find((c) => c.key === 'gps')!.status).toBe('OK');
    expect(report!.isReady).toBe(false); // horaires et catalogue manquent encore
  });

  it('5. ouvrir au moins un jour coche les horaires', async () => {
    await prisma.operatingHours.updateMany({
      where: { restaurantId: VENDOR_ID },
      data: { isClosed: false },
    });

    const report = await readiness.getReport(VENDOR_ID);
    expect(report!.checks.find((c) => c.key === 'hours')!.status).toBe('OK');
  });

  it('6. un produit sans variante ne rend pas la boutique vendable', async () => {
    await prisma.product.create({
      data: {
        id: 'onb-prod-orphan',
        nom: 'Croissant sans variante',
        prixOriginal: 500,
        restaurantId: VENDOR_ID,
      },
    });

    // La règle est « au moins un produit **commandable** » : sans variante, il
    // n'y a pas de prix à mettre au panier.
    const report = await readiness.getReport(VENDOR_ID);
    expect(report!.checks.find((c) => c.key === 'catalog')!.status).toBe(
      'MISSING',
    );
  });

  it('7. un produit avec variante rend la boutique prête', async () => {
    await prisma.product.create({
      data: {
        id: 'onb-prod-1',
        nom: 'Baguette tradition',
        prixOriginal: 500,
        restaurantId: VENDOR_ID,
        variants: { create: [{ id: 'onb-var-1', label: 'Unité', prix: 500 }] },
      },
    });

    const report = await readiness.getReport(VENDOR_ID);
    expect(report!.checks.find((c) => c.key === 'catalog')!.status).toBe('OK');
    expect(report!.isReady).toBe(true);
    expect(report!.progress).toBe(100);
  });

  it("8. prêt ne signifie pas visible : l'activation reste une décision humaine", async () => {
    const report = await readiness.getReport(VENDOR_ID);
    expect(report!.isReady).toBe(true);
    // Toujours invisible : la checklist ouvre le droit d'activer, elle n'active pas.
    expect(await visibleToClients()).toBeNull();
  });

  // ─── Étape 10 — activation ─────────────────────────────────────────────────

  it('9. après activation, le client voit la boutique', async () => {
    await prisma.restaurant.updateMany({
      where: {
        id: VENDOR_ID,
        onboardingStatus: { not: OnboardingStatus.ACTIVATED },
      },
      data: {
        onboardingStatus: OnboardingStatus.ACTIVATED,
        activatedAt: new Date(),
        activatedById: 'admin-test',
        isOpen: true, // le cron l'ouvrirait selon les horaires
      },
    });

    const visible = await visibleToClients();
    expect(visible).not.toBeNull();
    expect(visible!.nom).toBe('Boulangerie du Test');
  });

  it('10. le client voit nom, description, logo, adresse, horaires et prix', async () => {
    const vendor = await prisma.restaurant.findFirst({
      where: { id: VENDOR_ID, ...PUBLIC_VENDOR_WHERE },
      include: {
        quartier: true,
        operatingHours: true,
        products: { include: { variants: true } },
      },
    });

    expect(vendor!.description).toContain('Pain frais');
    expect(vendor!.imageUrl).toBe('https://cdn.test/logo.png');
    expect(vendor!.quartier!.nom).toBe('Bacongo-Test');
    expect(vendor!.quartier!.ville).toBe('Brazzaville');
    expect(vendor!.latitude).toBeCloseTo(-4.2891, 3);
    expect(vendor!.operatingHours.filter((h) => !h.isClosed)).toHaveLength(7);

    const baguette = vendor!.products.find((p) => p.id === 'onb-prod-1');
    expect(baguette!.variants[0].prix).toBe(500);
  });

  it('11. le client peut mettre un produit de cette boutique au panier', async () => {
    await prisma.user.create({
      data: {
        id: 'onb-client-1',
        firebaseUid: 'fb-onb-client',
        email: 'client@test.local',
        role: 'CLIENT',
      },
    });
    const cart = await prisma.cart.create({ data: { userId: 'onb-client-1' } });

    const item = await prisma.cartItem.create({
      data: {
        cartId: cart.id,
        productId: 'onb-prod-1',
        variantId: 'onb-var-1',
        quantite: 2,
      },
      include: { variant: true, product: true },
    });

    expect(item.quantite).toBe(2);
    expect(item.variant.prix).toBe(500);
    expect(item.product.restaurantId).toBe(VENDOR_ID);
  });

  // ─── Retour arrière ────────────────────────────────────────────────────────

  it('12. suspendre le vendeur le retire du catalogue sans toucher au reste', async () => {
    await prisma.restaurant.update({
      where: { id: VENDOR_ID },
      data: { isActive: false, isOpen: false },
    });

    expect(await visibleToClients()).toBeNull();

    // La boutique existe toujours : produits, horaires et historique intacts.
    const still = await prisma.restaurant.findUnique({
      where: { id: VENDOR_ID },
      include: { products: true, operatingHours: true },
    });
    expect(still!.onboardingStatus).toBe(OnboardingStatus.ACTIVATED);
    expect(still!.products.length).toBeGreaterThan(0);
    expect(still!.operatingHours).toHaveLength(7);

    // Réactivation : le vendeur redevient visible sans repasser par l'onboarding.
    await prisma.restaurant.update({
      where: { id: VENDOR_ID },
      data: { isActive: true },
    });
    expect(await visibleToClients()).not.toBeNull();
  });

  it('13. un vendeur non approuvé reste invisible même une fois activé', async () => {
    // Deux questions distinctes : « configuré » (onboarding) et « accepté sur
    // la marketplace » (validation). Satisfaire l'une ne dispense pas de l'autre.
    await prisma.restaurant.update({
      where: { id: VENDOR_ID },
      data: { adminApproved: false },
    });
    expect(await visibleToClients()).toBeNull();

    await prisma.restaurant.update({
      where: { id: VENDOR_ID },
      data: { adminApproved: true },
    });
    expect(await visibleToClients()).not.toBeNull();
  });
});
