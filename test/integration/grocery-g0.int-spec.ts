import { PrismaPg } from '@prisma/adapter-pg';
import {
  OnboardingStatus,
  PrismaClient,
  ProductType,
  VendorType,
} from '@prisma/client';

import { PUBLIC_VENDOR_WHERE } from '../../apps/lilia-app/src/common/vendor-visibility';
import { catalogProductWhere } from '../../apps/lilia-app/src/modules/products/product-availability';
import { StockService } from '../../apps/lilia-app/src/modules/orders/stock.service';

/**
 * G0 — caractérisation GROCERY sur un **vrai PostgreSQL** (comportement actuel).
 *
 * Base dédiée uniquement (`TEST_DATABASE_URL`, vidée entre chaque cas). Se
 * saute sans elle — vérifier dans la sortie que les cas ont réellement tourné.
 */
const DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

describeIfDb('G0 — épicerie (PostgreSQL réel)', () => {
  let prisma: PrismaClient;
  const stock = new StockService();

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
    await prisma.$executeRawUnsafe(`
      TRUNCATE TABLE "OrderItem", "OrderHistory", "Order", "CartItem", "Cart",
                     "MenuProduct", "MenuDuJour", "ProductVariant", "Product",
                     "Category", "Restaurant", "User"
      RESTART IDENTITY CASCADE
    `);
  });

  async function vendor(
    id: string,
    data: Partial<{
      onboardingStatus: OnboardingStatus;
      adminApproved: boolean;
      isActive: boolean;
      vendorType: VendorType;
    }> = {},
  ) {
    await prisma.user.create({
      data: {
        id: `o-${id}`,
        firebaseUid: `fb-${id}`,
        email: `${id}@test.local`,
      },
    });
    return prisma.restaurant.create({
      data: {
        id,
        nom: `Boutique ${id}`,
        adresse: 'Brazzaville',
        phone: '060000000',
        ownerId: `o-${id}`,
        vendorType: VendorType.GROCERY,
        ...data,
      },
    });
  }

  async function product(
    id: string,
    restaurantId: string,
    data: Partial<{
      productType: ProductType;
      isAvailable: boolean;
      deletedAt: Date;
      stockRestant: number;
    }> = {},
  ) {
    const limited = data.stockRestant !== undefined;
    return prisma.product.create({
      data: {
        id,
        nom: `Article ${id}`,
        prixOriginal: 1000,
        restaurantId,
        productType: data.productType ?? ProductType.GROCERY,
        isAvailable: data.isAvailable ?? true,
        deletedAt: data.deletedAt,
        ...(limited
          ? {
              stockPolicy: 'INVENTORY',
              stockMode: 'PERMANENT',
              stockQuotidien: data.stockRestant,
              stockRestant: data.stockRestant,
            }
          : {}),
        variants: {
          create: [
            { id: `${id}-v`, label: 'Unité', prix: 1000, stockConsumption: 1 },
          ],
        },
      },
    });
  }

  const publicCatalog = () =>
    prisma.product.findMany({
      where: {
        restaurant: PUBLIC_VENDOR_WHERE,
        AND: [catalogProductWhere(prisma.product.fields)],
      },
      select: { id: true },
      orderBy: { id: 'asc' },
    });

  // ─── R-03 ──────────────────────────────────────────────────────────────────

  it('R-03 — un vendeur GROCERY créé sans statut explicite naît DRAFT, non approuvé, fermé', async () => {
    // Reproduit ce qu'écrivent POST /vendors et POST /admin/restaurants : ni
    // l'un ni l'autre ne pose `onboardingStatus`, ni `isOpen`.
    const created = await vendor('g-new');
    expect(created).toMatchObject({
      vendorType: VendorType.GROCERY,
      onboardingStatus: OnboardingStatus.DRAFT,
      adminApproved: false,
      isActive: true,
      isOpen: false,
    });
  });

  // ─── R-05 ──────────────────────────────────────────────────────────────────

  it('R-05 — seule l’épicerie ACTIVATED + approuvée + active est publique, elle et ses produits', async () => {
    const pub = {
      onboardingStatus: OnboardingStatus.ACTIVATED,
      adminApproved: true,
    };
    await vendor('g-pub', pub);
    await vendor('g-draft', { adminApproved: true });
    await vendor('g-ready', {
      adminApproved: true,
      onboardingStatus: OnboardingStatus.READY,
    });
    await vendor('g-unapproved', {
      onboardingStatus: OnboardingStatus.ACTIVATED,
    });
    await vendor('g-suspended', { ...pub, isActive: false });
    for (const v of [
      'g-pub',
      'g-draft',
      'g-ready',
      'g-unapproved',
      'g-suspended',
    ]) {
      await product(`${v}-p`, v);
    }

    const vendors = await prisma.restaurant.findMany({
      where: { ...PUBLIC_VENDOR_WHERE, vendorType: VendorType.GROCERY },
      select: { id: true },
    });
    expect(vendors.map((v) => v.id)).toEqual(['g-pub']);
    expect((await publicCatalog()).map((p) => p.id)).toEqual(['g-pub-p']);
  });

  it('R-05/R-07 — produit désactivé ou retiré d’une épicerie publique : hors catalogue', async () => {
    await vendor('g1', {
      onboardingStatus: OnboardingStatus.ACTIVATED,
      adminApproved: true,
    });
    await product('ok', 'g1');
    await product('off', 'g1', { isAvailable: false });
    await product('gone', 'g1', { deletedAt: new Date('2026-10-01') });
    await product('empty', 'g1', { stockRestant: 0 });

    // Épuisé : RESTE au catalogue (affiché « Rupture »), refusé au panier.
    expect((await publicCatalog()).map((p) => p.id)).toEqual(['empty', 'ok']);
  });

  // ─── R-06 ──────────────────────────────────────────────────────────────────

  it('[ACTUEL] R-06 — une ligne ALCOHOL écrite hors service serait servie au catalogue public', async () => {
    // Aucune contrainte en base n'interdit `productType = ALCOHOL`, et le
    // filtre du catalogue n'en lit pas le type. Seul le service refuse.
    await vendor('g1', {
      onboardingStatus: OnboardingStatus.ACTIVATED,
      adminApproved: true,
    });
    await product('beer', 'g1', { productType: ProductType.ALCOHOL });
    expect((await publicCatalog()).map((p) => p.id)).toEqual(['beer']);
  });

  // ─── R-07 ──────────────────────────────────────────────────────────────────

  describe('R-07 — panier de 30 références en stock réel', () => {
    const N = 30;
    const ids = Array.from(
      { length: N },
      (_, i) => `ref-${String(i).padStart(2, '0')}`,
    );
    const basket = (order: string[], quantite: number) =>
      order.map((id) => ({
        productId: id,
        menuId: null,
        quantite,
        variant: { stockConsumption: 1, label: 'Unité' },
        variantId: `${id}-v`,
        product: { nom: `Article ${id}` },
      }));

    beforeEach(async () => {
      await vendor('g1', {
        onboardingStatus: OnboardingStatus.ACTIVATED,
        adminApproved: true,
      });
      for (const id of ids) await product(id, 'g1', { stockRestant: 5 });
    });

    const reserve = (lines: ReturnType<typeof basket>) =>
      prisma
        .$transaction((tx) => stock.decrementInTransaction(tx, lines))
        .then(
          () => true,
          (error: { response?: { code?: string } }) => {
            if (error.response?.code !== 'OUT_OF_STOCK') throw error;
            return false;
          },
        );

    const stocks = async () =>
      (
        await prisma.product.findMany({
          where: { restaurantId: 'g1' },
          select: { stockRestant: true },
        })
      ).map((p) => p.stockRestant);

    it('deux paniers identiques de 3 unités sur un stock de 5 : un seul passe, aucun stock négatif', async () => {
      const results = await Promise.all([
        reserve(basket(ids, 3)),
        reserve(basket([...ids].reverse(), 3)),
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(new Set(await stocks())).toEqual(new Set([2]));
    });

    it('dix paniers d’une unité en ordres croisés : tous passent, aucun interblocage', async () => {
      const results = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          reserve(basket(i % 2 ? ids : [...ids].reverse(), 1)),
        ),
      );
      // 10 × 1 sur un stock de 5 : exactement 5 succès, stock à 0 partout.
      expect(results.filter(Boolean)).toHaveLength(5);
      expect(new Set(await stocks())).toEqual(new Set([0]));
    });
  });
});
