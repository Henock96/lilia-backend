import { PrismaPg } from '@prisma/adapter-pg';
import { OnboardingStatus, PrismaClient, VendorType } from '@prisma/client';

import {
  PUBLIC_VENDOR_ORDER_BY,
  PUBLIC_VENDOR_WHERE,
} from '../../apps/lilia-app/src/common/vendor-visibility';

/**
 * Classement, mise en avant et visibilité — sur un vrai PostgreSQL.
 *
 * Les tests unitaires vérifient qu'on **construit** la bonne requête. Ils ne
 * peuvent pas dire dans quel ordre PostgreSQL rend réellement les lignes, ni
 * ce qu'il fait de deux vendeurs qui partagent le même `displayOrder`, ni si
 * un `DRAFT` classé premier ressort quand même. C'est précisément ce qui
 * importe ici, et c'est pourquoi ce fichier interroge la base directement,
 * avec le `where` et l'`orderBy` que sert l'API publique.
 *
 * Se saute proprement sans `TEST_DATABASE_URL`.
 */
const DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

describeIfDb('Catalogue public — ordre, vedettes et visibilité', () => {
  let prisma: PrismaClient;

  /** Réplique exacte de la requête de `VendorsService.findAll`. */
  const publicCatalogue = (extra: Record<string, unknown> = {}) =>
    prisma.restaurant.findMany({
      where: { ...PUBLIC_VENDOR_WHERE, ...extra },
      orderBy: [...PUBLIC_VENDOR_ORDER_BY],
      select: { nom: true, displayOrder: true, isFeatured: true, isOpen: true },
    });

  const vendeur = (
    id: string,
    nom: string,
    over: Record<string, unknown> = {},
  ) => ({
    id,
    nom,
    adresse: 'Brazzaville',
    phone: '060000000',
    vendorType: VendorType.RESTAURANT,
    onboardingStatus: OnboardingStatus.ACTIVATED,
    adminApproved: true,
    isActive: true,
    isOpen: true,
    owner: {
      create: {
        id: `owner-${id}`,
        firebaseUid: `fb-${id}`,
        email: `${id}@showcase.test`,
        nom,
        role: 'RESTAURATEUR' as const,
      },
    },
    ...over,
  });

  beforeAll(async () => {
    prisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: DATABASE_URL }),
    });
    await prisma.$connect();

    await prisma.$executeRawUnsafe(`
      TRUNCATE TABLE "DeliveryReview", "DeliveryLocation", "Delivery",
                     "LoyaltyTransaction", "OrderItem", "OrderHistory",
                     "payments", "Refund", "Order", "CartItem", "Cart",
                     "VendorPhoto", "OperatingHours", "Specialty",
                     "VendorProfile", "ProductVariant", "Product", "Category",
                     "QuartierZone", "DeliveryZone", "DriverProfile",
                     "Restaurant", "Quartier", "User"
      RESTART IDENTITY CASCADE
    `);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  // ─── TEST 9 — l'ordre ──────────────────────────────────────────────────────

  describe('displayOrder', () => {
    beforeAll(async () => {
      // A = 3, B = 1, C = 2 → attendu B, C, A.
      await prisma.restaurant.create({
        data: vendeur('sc-a', 'A', { displayOrder: 3 }),
      });
      await prisma.restaurant.create({
        data: vendeur('sc-b', 'B', { displayOrder: 1 }),
      });
      await prisma.restaurant.create({
        data: vendeur('sc-c', 'C', { displayOrder: 2 }),
      });
    });

    it('rend les vendeurs dans l’ordre voulu par l’administrateur', async () => {
      const noms = (await publicCatalogue()).map((r) => r.nom);
      expect(noms).toEqual(['B', 'C', 'A']);
    });

    /**
     * `isOpen` passe AVANT `displayOrder` : un client qui ne peut pas commander
     * maintenant n'a que faire d'un vendeur bien classé. La règle n'a de sens
     * que si elle tient sur des données réelles.
     */
    it('un vendeur fermé passe derrière les ouverts, même classé premier', async () => {
      await prisma.restaurant.update({
        where: { id: 'sc-b' },
        data: { isOpen: false },
      });

      const noms = (await publicCatalogue()).map((r) => r.nom);
      expect(noms).toEqual(['C', 'A', 'B']);

      await prisma.restaurant.update({
        where: { id: 'sc-b' },
        data: { isOpen: true },
      });
    });

    /**
     * Les doublons sont autorisés — « ces deux-là devant, l'ordre entre eux
     * m'est égal ». Le départage revient à `createdAt desc`, ce qui rend le
     * résultat stable au lieu d'être laissé au hasard du plan d'exécution.
     */
    it('à displayOrder égal, le plus récent passe devant (départage stable)', async () => {
      await prisma.restaurant.updateMany({
        where: { id: { in: ['sc-a', 'sc-b', 'sc-c'] } },
        data: { displayOrder: 5 },
      });

      const noms = (await publicCatalogue()).map((r) => r.nom);
      // C a été créé en dernier, A en premier.
      expect(noms).toEqual(['C', 'B', 'A']);

      const premier = await publicCatalogue();
      const second = await publicCatalogue();
      expect(second.map((r) => r.nom)).toEqual(premier.map((r) => r.nom));
    });

    it('le défaut vaut 1000 — un nouveau vendeur ne passe pas devant', async () => {
      await prisma.restaurant.create({
        data: vendeur('sc-d', 'D'), // aucun displayOrder fourni
      });
      const d = await prisma.restaurant.findUniqueOrThrow({
        where: { id: 'sc-d' },
        select: { displayOrder: true },
      });
      expect(d.displayOrder).toBe(1000);

      const noms = (await publicCatalogue()).map((r) => r.nom);
      expect(noms[noms.length - 1]).toBe('D');
    });
  });

  // ─── TEST 10 — les vedettes ────────────────────────────────────────────────

  describe('isFeatured', () => {
    beforeAll(async () => {
      await prisma.restaurant.update({
        where: { id: 'sc-a' },
        data: { isFeatured: true },
      });
      await prisma.restaurant.update({
        where: { id: 'sc-c' },
        data: { isFeatured: true },
      });
    });

    /**
     * Le point du TEST 10 : la section « en vedette » doit rendre A et C, pas
     * « les premiers de la liste ». Avant, le site prenait `slice(0, 4)` sur le
     * catalogue trié par date — il affichait donc les derniers créés sous un
     * titre qui promettait une sélection éditoriale.
     */
    it('ne rend QUE les vendeurs mis en avant', async () => {
      const noms = (await publicCatalogue({ isFeatured: true }))
        .map((r) => r.nom)
        .sort();
      expect(noms).toEqual(['A', 'C']);
    });

    it('la mise en avant est indépendante de la position', async () => {
      // A est mis en avant ET rangé loin ; B est premier sans badge.
      await prisma.restaurant.update({
        where: { id: 'sc-a' },
        data: { displayOrder: 50 },
      });
      await prisma.restaurant.update({
        where: { id: 'sc-b' },
        data: { displayOrder: 1, isFeatured: false },
      });

      const tous = await publicCatalogue();
      expect(tous[0]).toMatchObject({ nom: 'B', isFeatured: false });

      const vedettes = (await publicCatalogue({ isFeatured: true })).map(
        (r) => r.nom,
      );
      expect(vedettes).toContain('A');
      expect(vedettes).not.toContain('B');
    });
  });

  // ─── TEST 11 — la visibilité prime sur tout ────────────────────────────────

  describe('visibilité', () => {
    /**
     * Le scénario exact demandé : `DRAFT` + `displayOrder = 1` +
     * `isFeatured = true`. Il ne doit apparaître ni dans le catalogue, ni dans
     * la sélection en vedette.
     *
     * Ce n'est pas une convention respectée par les développeurs : la
     * visibilité vit dans le `where` et le classement dans l'`orderBy`, donc
     * PostgreSQL ne peut pas rendre cette ligne, quelles que soient les deux
     * autres colonnes.
     */
    it('un DRAFT classé premier et mis en avant reste invisible', async () => {
      await prisma.restaurant.create({
        data: vendeur('sc-draft', 'Brouillon', {
          onboardingStatus: OnboardingStatus.DRAFT,
          displayOrder: 1,
          isFeatured: true,
        }),
      });

      expect((await publicCatalogue()).map((r) => r.nom)).not.toContain(
        'Brouillon',
      );
      expect(
        (await publicCatalogue({ isFeatured: true })).map((r) => r.nom),
      ).not.toContain('Brouillon');
    });

    it('un vendeur suspendu classé premier reste invisible', async () => {
      await prisma.restaurant.create({
        data: vendeur('sc-susp', 'Suspendu', {
          isActive: false,
          displayOrder: 1,
          isFeatured: true,
        }),
      });
      expect((await publicCatalogue()).map((r) => r.nom)).not.toContain(
        'Suspendu',
      );
    });

    it('un vendeur non approuvé classé premier reste invisible', async () => {
      await prisma.restaurant.create({
        data: vendeur('sc-napp', 'NonApprouve', {
          adminApproved: false,
          displayOrder: 1,
          isFeatured: true,
        }),
      });
      expect((await publicCatalogue()).map((r) => r.nom)).not.toContain(
        'NonApprouve',
      );
    });
  });
});
