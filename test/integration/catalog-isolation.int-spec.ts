import { PrismaPg } from '@prisma/adapter-pg';
import { OnboardingStatus, PrismaClient, VendorType } from '@prisma/client';

import { PUBLIC_VENDOR_WHERE } from '../../apps/lilia-app/src/common/vendor-visibility';
import {
  availableProductWhere,
  catalogProductWhere,
} from '../../apps/lilia-app/src/modules/products/product-availability';
import { slugifyCategoryName } from '../../apps/lilia-app/src/modules/categories/category-slug';

/**
 * Isolation du catalogue entre vendeurs, sur un **vrai PostgreSQL**.
 *
 * Aucun test unitaire ne peut couvrir ce fichier : ce qu'on y vérifie est une
 * propriété de la **base** — la clé étrangère composite
 * `(categoryId, restaurantId) → Category(id, restaurantId)` — et un mock de
 * Prisma accepterait joyeusement une écriture que PostgreSQL refuse.
 *
 * C'est la différence entre « le service contient un `if` » et « l'écriture est
 * impossible ». Seule la seconde tient face à un script d'administration, une
 * migration SQL manuelle ou un futur endpoint qui oublierait le contrôle.
 *
 * Se saute proprement sans `TEST_DATABASE_URL`.
 */
const DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

describeIfDb('Catalogue — isolation entre vendeurs (PostgreSQL réel)', () => {
  let prisma: PrismaClient;

  const A = { owner: 'iso-owner-a', resto: 'iso-resto-a' };
  const B = { owner: 'iso-owner-b', resto: 'iso-resto-b' };
  const DRAFT = { owner: 'iso-owner-d', resto: 'iso-resto-d' };

  /** Crée un vendeur visible (activé, approuvé, actif) ou en DRAFT. */
  async function createVendor(
    ids: { owner: string; resto: string },
    nom: string,
    status: OnboardingStatus,
  ) {
    await prisma.user.create({
      data: {
        id: ids.owner,
        firebaseUid: `fb-${ids.owner}`,
        email: `${ids.owner}@test.cg`,
        role: 'RESTAURATEUR',
      },
    });
    await prisma.restaurant.create({
      data: {
        id: ids.resto,
        nom,
        adresse: 'Brazzaville',
        phone: '060000000',
        ownerId: ids.owner,
        vendorType: VendorType.RESTAURANT,
        onboardingStatus: status,
        adminApproved: true,
        isActive: true,
      },
    });
  }

  async function createCategory(restoId: string, nom: string, ordre = 0) {
    return prisma.category.create({
      data: {
        restaurantId: restoId,
        nom,
        slug: slugifyCategoryName(nom),
        displayOrder: ordre,
      },
    });
  }

  async function createProduct(
    restoId: string,
    nom: string,
    categoryId?: string | null,
  ) {
    return prisma.product.create({
      data: { nom, prixOriginal: 1000, restaurantId: restoId, categoryId },
    });
  }

  beforeAll(async () => {
    prisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: DATABASE_URL }),
    });
    await prisma.$connect();

    await prisma.$executeRawUnsafe(`
      TRUNCATE TABLE "DeliveryReview", "DeliveryLocation", "Delivery",
                     "LoyaltyTransaction", "OrderItem", "OrderHistory",
                     "payments", "Refund", "Order", "CartItem", "Cart",
                     "MenuProduct", "MenuImage", "MenuDuJour",
                     "VendorPhoto", "OperatingHours", "Specialty",
                     "VendorProfile", "ProductImage", "ProductVariant",
                     "Product", "Category",
                     "QuartierZone", "DeliveryZone", "Restaurant",
                     "Quartier", "User"
      RESTART IDENTITY CASCADE
    `);

    await createVendor(A, 'Chez A', OnboardingStatus.ACTIVATED);
    await createVendor(B, 'Chez B', OnboardingStatus.ACTIVATED);
    await createVendor(DRAFT, 'En configuration', OnboardingStatus.DRAFT);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // §27 — LE test critique : la base refuse le cross-vendeur
  // ═══════════════════════════════════════════════════════════════════════════
  describe('§27 — un produit du vendeur A ne peut pas porter une section de B', () => {
    let catA: { id: string };
    let catB: { id: string };

    beforeAll(async () => {
      catA = await createCategory(A.resto, 'Boissons');
      catB = await createCategory(B.resto, 'Burgers');
    });

    it('INSERT cross-vendeur → refusé par PostgreSQL', async () => {
      await expect(
        createProduct(A.resto, 'Produit pirate', catB.id),
      ).rejects.toThrow();
    });

    it('UPDATE cross-vendeur → refusé par PostgreSQL', async () => {
      const p = await createProduct(A.resto, 'Coca A', catA.id);
      await expect(
        prisma.product.update({
          where: { id: p.id },
          data: { categoryId: catB.id },
        }),
      ).rejects.toThrow();

      // Contre-épreuve : la ligne n'a pas bougé.
      const relu = await prisma.product.findUnique({ where: { id: p.id } });
      expect(relu?.categoryId).toBe(catA.id);
    });

    it('même vendeur → accepté (contre-épreuve)', async () => {
      const p = await createProduct(A.resto, 'Fanta A', null);
      const maj = await prisma.product.update({
        where: { id: p.id },
        data: { categoryId: catA.id },
      });
      expect(maj.categoryId).toBe(catA.id);
    });

    it('produit sans section → accepté (la FK composite laisse passer les NULL)', async () => {
      const p = await createProduct(A.resto, 'Sans section', null);
      expect(p.categoryId).toBeNull();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // §33 — deux vendeurs, la même « Boissons »
  // ═══════════════════════════════════════════════════════════════════════════
  describe('§33 — deux vendeurs peuvent avoir le même nom de section', () => {
    it('B crée « Boissons » alors que A l’a déjà', async () => {
      const boissonsB = await createCategory(B.resto, 'Boissons');
      expect(boissonsB.slug).toBe('boissons');

      const toutes = await prisma.category.findMany({
        where: { slug: 'boissons' },
      });
      expect(toutes).toHaveLength(2);
      expect(new Set(toutes.map((c) => c.restaurantId))).toEqual(
        new Set([A.resto, B.resto]),
      );
    });

    it('mais un même vendeur ne peut pas l’avoir deux fois', async () => {
      // Y compris avec une casse ou des espaces différents : c'est le slug qui
      // porte l'unicité, pas le libellé brut.
      await expect(createCategory(A.resto, '  BOISSONS ')).rejects.toThrow();
    });

    it('chaque vendeur ne voit que les siennes', async () => {
      const desA = await prisma.category.findMany({
        where: { restaurantId: A.resto },
      });
      const desB = await prisma.category.findMany({
        where: { restaurantId: B.resto },
      });

      expect(desA.every((c) => c.restaurantId === A.resto)).toBe(true);
      expect(desB.every((c) => c.restaurantId === B.resto)).toBe(true);
      expect(desA.map((c) => c.id)).not.toEqual(
        expect.arrayContaining(desB.map((c) => c.id)),
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // §31 / §32 — cycle de vie d'une section
  // ═══════════════════════════════════════════════════════════════════════════
  describe('§31 — une section vide reste visible du propriétaire', () => {
    it('créée sans produit, elle est bien là ; puis remplie ; puis revidée', async () => {
      const vide = await createCategory(A.resto, 'Desserts', 9);

      const vueProprio = () =>
        prisma.category.findMany({ where: { restaurantId: A.resto } });

      expect((await vueProprio()).map((c) => c.id)).toContain(vide.id);

      const p = await createProduct(A.resto, 'Tiramisu', vide.id);
      expect((await vueProprio()).map((c) => c.id)).toContain(vide.id);

      await prisma.product.delete({ where: { id: p.id } });
      // C'est ICI que l'ancien filtre `products: { some: ... }` la faisait
      // disparaître — et elle ne pouvait plus jamais être remplie.
      expect((await vueProprio()).map((c) => c.id)).toContain(vide.id);
    });

    it('mais la vue CLIENT ne montre pas une section vide', async () => {
      const vide = await prisma.category.findFirst({
        where: { restaurantId: A.resto, slug: 'desserts' },
      });
      const vuePublique = await prisma.category.findMany({
        where: {
          restaurantId: A.resto,
          isActive: true,
          products: { some: availableProductWhere() },
        },
      });
      expect(vuePublique.map((c) => c.id)).not.toContain(vide!.id);
    });
  });

  describe('§32 — supprimer une section ne supprime aucun produit', () => {
    it('les produits survivent, détachés et toujours vendables', async () => {
      const cat = await createCategory(A.resto, 'À supprimer', 8);
      const p1 = await createProduct(A.resto, 'Produit 1', cat.id);
      const p2 = await createProduct(A.resto, 'Produit 2', cat.id);

      // Exactement la transaction de `CategoriesService.remove` : détacher
      // d'abord, supprimer ensuite. La FK est en RESTRICT, donc l'ordre n'est
      // pas cosmétique — c'est ce qui fait que la suppression aboutit.
      const detaches = await prisma.$transaction(async (tx) => {
        const { count } = await tx.product.updateMany({
          where: { categoryId: cat.id },
          data: { categoryId: null },
        });
        await tx.category.delete({ where: { id: cat.id } });
        return count;
      });

      expect(detaches).toBe(2);
      expect(
        await prisma.category.findUnique({ where: { id: cat.id } }),
      ).toBeNull();

      for (const id of [p1.id, p2.id]) {
        const p = await prisma.product.findUnique({ where: { id } });
        expect(p).not.toBeNull();
        expect(p!.categoryId).toBeNull();
        expect(p!.deletedAt).toBeNull();
        expect(p!.isAvailable).toBe(true);
      }
    });

    it('supprimer sans détacher est REFUSÉ par la base', async () => {
      // Le garde-fou qui rend impossible la perte accidentelle de produits,
      // y compris depuis un script hors application.
      const cat = await createCategory(A.resto, 'Protégée', 7);
      await createProduct(A.resto, 'Produit protégé', cat.id);

      await expect(
        prisma.category.delete({ where: { id: cat.id } }),
      ).rejects.toThrow();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // §29 / §30 — frontière marketplace et produits retirés
  // ═══════════════════════════════════════════════════════════════════════════
  describe('§29 — un vendeur DRAFT n’expose rien publiquement', () => {
    beforeAll(async () => {
      const cat = await createCategory(DRAFT.resto, 'Plats');
      await createProduct(DRAFT.resto, 'Plat secret', cat.id);
      await prisma.menuDuJour.create({
        data: {
          nom: 'Menu secret',
          prix: 5000,
          restaurantId: DRAFT.resto,
          dateDebut: new Date(Date.now() - 3600_000),
          dateFin: new Date(Date.now() + 3600_000),
        },
      });
    });

    it('absent du catalogue vendeurs', async () => {
      const publics = await prisma.restaurant.findMany({
        where: PUBLIC_VENDOR_WHERE,
      });
      expect(publics.map((r) => r.id)).not.toContain(DRAFT.resto);
    });

    it('ses produits sont absents du catalogue public', async () => {
      const produits = await prisma.product.findMany({
        where: {
          restaurant: PUBLIC_VENDOR_WHERE,
          AND: [availableProductWhere()],
        },
      });
      expect(produits.map((p) => p.restaurantId)).not.toContain(DRAFT.resto);
    });

    it('ses menus sont absents des menus publics (fix SEC-02)', async () => {
      const menus = await prisma.menuDuJour.findMany({
        where: { restaurant: PUBLIC_VENDOR_WHERE },
      });
      expect(menus.map((m) => m.restaurantId)).not.toContain(DRAFT.resto);
    });

    it('activé, il devient visible ; suspendu, il disparaît', async () => {
      await prisma.restaurant.update({
        where: { id: DRAFT.resto },
        data: { onboardingStatus: OnboardingStatus.ACTIVATED },
      });
      let publics = await prisma.restaurant.findMany({
        where: PUBLIC_VENDOR_WHERE,
      });
      expect(publics.map((r) => r.id)).toContain(DRAFT.resto);

      await prisma.restaurant.update({
        where: { id: DRAFT.resto },
        data: { isActive: false },
      });
      publics = await prisma.restaurant.findMany({
        where: PUBLIC_VENDOR_WHERE,
      });
      expect(publics.map((r) => r.id)).not.toContain(DRAFT.resto);

      // Remis en état pour ne pas polluer les tests suivants.
      await prisma.restaurant.update({
        where: { id: DRAFT.resto },
        data: { isActive: true },
      });
    });
  });

  describe('§30 — un produit retiré disparaît de toutes les vues publiques', () => {
    it('deletedAt le retire du catalogue, de la recherche et des sections', async () => {
      const cat = await createCategory(B.resto, 'Éphémère', 5);
      const p = await createProduct(B.resto, 'Produit retiré', cat.id);

      const visibles = () =>
        prisma.product.findMany({
          where: {
            restaurant: PUBLIC_VENDOR_WHERE,
            AND: [availableProductWhere()],
          },
        });
      expect((await visibles()).map((x) => x.id)).toContain(p.id);

      await prisma.product.update({
        where: { id: p.id },
        data: { deletedAt: new Date(), isAvailable: false },
      });

      expect((await visibles()).map((x) => x.id)).not.toContain(p.id);

      // Et sa section, devenue vide, sort de la vue client — sans disparaître
      // de la vue propriétaire.
      const vuePublique = await prisma.category.findMany({
        where: {
          restaurantId: B.resto,
          isActive: true,
          products: { some: availableProductWhere() },
        },
      });
      expect(vuePublique.map((c) => c.id)).not.toContain(cat.id);

      const vueProprio = await prisma.category.findMany({
        where: { restaurantId: B.resto },
      });
      expect(vueProprio.map((c) => c.id)).toContain(cat.id);
    });
  });

  describe('Section désactivée', () => {
    it('sort de la vue client, ses produits restent vendables', async () => {
      const cat = await createCategory(B.resto, 'Masquée', 4);
      const p = await createProduct(B.resto, 'Toujours en vente', cat.id);

      await prisma.category.update({
        where: { id: cat.id },
        data: { isActive: false },
      });

      const vuePublique = await prisma.category.findMany({
        where: { restaurantId: B.resto, isActive: true },
      });
      expect(vuePublique.map((c) => c.id)).not.toContain(cat.id);

      const produit = await prisma.product.findFirst({
        where: {
          id: p.id,
          restaurant: PUBLIC_VENDOR_WHERE,
          AND: [availableProductWhere()],
        },
      });
      expect(produit).not.toBeNull();
    });
  });

  describe('Suppression d’un vendeur', () => {
    it('emporte ses sections en cascade, jamais celles des autres', async () => {
      const jetable = { owner: 'iso-owner-x', resto: 'iso-resto-x' };
      await createVendor(jetable, 'Jetable', OnboardingStatus.DRAFT);
      await createCategory(jetable.resto, 'Plats');

      const avant = await prisma.category.count();
      await prisma.restaurant.delete({ where: { id: jetable.resto } });
      const apres = await prisma.category.count();

      expect(apres).toBe(avant - 1);
      expect(
        await prisma.category.count({ where: { restaurantId: A.resto } }),
      ).toBeGreaterThan(0);
    });
  });
});

/**
 * MENU-01 — le produit fantôme d'un PLAT_SPECIAL ne pollue plus le catalogue.
 *
 * Créer un menu `PLAT_SPECIAL` fabrique au passage un `Product` qui porte le
 * plat : c'est lui qui reçoit les lignes de commande. Mais ce n'est pas un
 * article du catalogue — sans exclusion, le même plat apparaissait deux fois
 * chez le client, une fois comme menu et une fois comme produit sans section.
 *
 * Le test vérifie les deux faces : le fantôme sort du catalogue, ET le menu
 * garde son composant. Ne vérifier que la première ferait passer une correction
 * qui vide les plats spéciaux.
 */
describeIfDb('MENU-01 — produit fantôme d’un PLAT_SPECIAL', () => {
  let prisma: PrismaClient;
  const V = { owner: 'ph-owner', resto: 'ph-resto' };
  let phantomId: string;
  let normalId: string;

  beforeAll(async () => {
    prisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: DATABASE_URL }),
    });
    await prisma.$connect();
    await prisma.$executeRawUnsafe(
      `TRUNCATE TABLE "MenuProduct", "MenuDuJour", "ProductVariant", "Product",
                      "Category", "OperatingHours", "Restaurant", "User"
       RESTART IDENTITY CASCADE`,
    );

    await prisma.user.create({
      data: {
        id: V.owner,
        firebaseUid: `fb-${V.owner}`,
        email: 'ph@test.cg',
        role: 'RESTAURATEUR',
      },
    });
    await prisma.restaurant.create({
      data: {
        id: V.resto,
        nom: 'Chez Fantôme',
        adresse: 'Brazzaville',
        phone: '060000000',
        ownerId: V.owner,
        vendorType: VendorType.RESTAURANT,
        onboardingStatus: OnboardingStatus.ACTIVATED,
        adminApproved: true,
        isActive: true,
      },
    });

    // Produit normal — doit rester au catalogue.
    normalId = (
      await prisma.product.create({
        data: {
          nom: 'Poulet braisé',
          prixOriginal: 3500,
          restaurantId: V.resto,
        },
      })
    ).id;

    // Produit fantôme + son menu, comme le fait MenuCommandService.
    phantomId = (
      await prisma.product.create({
        data: {
          nom: 'Plat spécial du jour',
          prixOriginal: 2500,
          restaurantId: V.resto,
        },
      })
    ).id;
    await prisma.menuDuJour.create({
      data: {
        nom: 'Plat spécial du jour',
        prix: 2500,
        type: 'PLAT_SPECIAL',
        restaurantId: V.resto,
        dateDebut: new Date(Date.now() - 3600_000),
        dateFin: new Date(Date.now() + 86_400_000),
        products: { create: { productId: phantomId, ordre: 0 } },
      },
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('le fantôme est absent du catalogue, le produit normal y reste', async () => {
    const catalogue = await prisma.product.findMany({
      where: { restaurant: PUBLIC_VENDOR_WHERE, AND: [catalogProductWhere()] },
    });
    const ids = catalogue.map((p) => p.id);
    expect(ids).toContain(normalId);
    expect(ids).not.toContain(phantomId);
  });

  it('mais le menu garde son composant — sinon le plat serait invendable', async () => {
    // C'est la contre-épreuve qui compte : `availableProductWhere` filtre aussi
    // le CONTENU des menus, et y appliquer l'exclusion viderait les
    // PLAT_SPECIAL. Les deux filtres doivent rester distincts.
    const menu = await prisma.menuDuJour.findFirst({
      where: { restaurantId: V.resto },
      include: { products: { where: { product: availableProductWhere() } } },
    });
    expect(menu?.products).toHaveLength(1);
    expect(menu?.products[0].productId).toBe(phantomId);
  });
});
