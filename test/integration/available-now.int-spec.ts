import { PrismaPg } from '@prisma/adapter-pg';
import {
  OnboardingStatus,
  OrderStatus,
  PrismaClient,
  VendorType,
} from '@prisma/client';

import { ProductQueryService } from '../../apps/lilia-app/src/modules/products/product-query.service';

/**
 * `GET /products/available-now` sur un vrai PostgreSQL.
 *
 * La régression à ne jamais revoir : « Plats populaires » prenait les 10 plus
 * commandés **puis** retirait les non-servables — à 01h18 le 30/09/2026, les
 * 10 venaient de vendeurs fermés et la section était pleine de plats qu'on ne
 * pouvait pas commander. Ici, le filtre précède la coupe, et c'est la base
 * elle-même qui le prouve (tri relationnel, `groupBy`, fenêtres horaires).
 *
 * Se saute proprement sans `TEST_DATABASE_URL`.
 */
const DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

describeIfDb('Disponible maintenant (PostgreSQL réel)', () => {
  let prisma: PrismaClient;
  let service: ProductQueryService;
  const USER = 'an-user';
  let orderSeq = 0;

  async function vendeur(
    id: string,
    over: Record<string, unknown> = {},
  ): Promise<string> {
    await prisma.restaurant.create({
      data: {
        id,
        nom: id,
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
            email: `${id}@available-now.test`,
            nom: id,
            role: 'RESTAURATEUR',
          },
        },
        ...over,
      },
    });
    return id;
  }

  async function produit(
    restaurantId: string,
    nom: string,
    over: Record<string, unknown> = {},
    variant: { stockConsumption?: number } | null = {},
  ): Promise<string> {
    const p = await prisma.product.create({
      data: {
        nom,
        prixOriginal: 2000,
        restaurantId,
        // CHECK F3-10 : un compteur de stock exige une politique qui en a un.
        ...(over.stockRestant != null && { stockPolicy: 'INVENTORY' }),
        ...(variant && {
          variants: { create: { label: 'Normal', prix: 2000, ...variant } },
        }),
        ...over,
      },
    });
    return p.id;
  }

  /** `n` commandes d'un produit, au statut et à la date voulus. */
  async function commandes(
    productId: string,
    restaurantId: string,
    n: number,
    status: OrderStatus = OrderStatus.LIVRER,
    daysAgo = 1,
  ) {
    for (let i = 0; i < n; i++) {
      await prisma.order.create({
        data: {
          id: `an-o-${++orderSeq}`,
          restaurantId,
          userId: USER,
          subTotal: 2000,
          deliveryFee: 0,
          total: 2000,
          paymentMethod: 'MTN_MOMO',
          status,
          createdAt: new Date(Date.now() - daysAgo * 24 * 3600_000),
          items: {
            create: { productId, variant: 'Normal', quantite: 1, prix: 2000 },
          },
        },
      });
    }
  }

  const ids = async (
    query: Parameters<ProductQueryService['findAvailableNow']>[0],
  ) => (await service.findAvailableNow(query)).data.map((p) => p.nom);

  beforeAll(async () => {
    prisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: DATABASE_URL }),
    });
    await prisma.$connect();
    service = new ProductQueryService(prisma as never, {} as never);
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(`
      TRUNCATE TABLE "OrderItem", "OrderHistory", "Order",
                     "MenuProduct", "MenuDuJour",
                     "ProductVariant", "Product", "Category",
                     "OperatingHours", "Restaurant", "User"
      RESTART IDENTITY CASCADE
    `);
    await prisma.user.create({
      data: {
        id: USER,
        firebaseUid: 'fb-an-user',
        email: 'client@available-now.test',
        nom: 'Client',
      },
    });
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  it('TEST CRITIQUE — 10 candidats, 9 de vendeurs fermés, limit=10 : l’ouvert apparaît', async () => {
    for (let i = 0; i < 9; i++) {
      const v = await vendeur(`ferme-${i}`, { isOpen: false });
      const p = await produit(v, `Plat fermé ${i}`);
      // Les plats fermés sont les plus livrés : un classement « populaire »
      // appliqué avant le filtre ne rendrait qu'eux.
      await commandes(p, v, 5);
    }
    const ouvert = await vendeur('ouvert');
    await produit(ouvert, 'Plat ouvert');

    expect(await ids({ limit: 10 })).toEqual(['Plat ouvert']);
  });

  it('même limit=1 : le filtre précède la coupe', async () => {
    const f = await vendeur('ferme', { isOpen: false });
    await commandes(await produit(f, 'Star fermée'), f, 50);
    await produit(await vendeur('ouvert'), 'Plat ouvert');

    expect(await ids({ limit: 1 })).toEqual(['Plat ouvert']);
  });

  it('frontière publique : non approuvé, DRAFT, suspendu exclus', async () => {
    await produit(
      await vendeur('na', { adminApproved: false }),
      'Non approuvé',
    );
    await produit(
      await vendeur('draft', { onboardingStatus: OnboardingStatus.DRAFT }),
      'Draft',
    );
    await produit(await vendeur('susp', { isActive: false }), 'Suspendu');
    await produit(await vendeur('ok'), 'Visible');

    expect(await ids({})).toEqual(['Visible']);
  });

  it('catalogue et stock : seuls les produits réellement commandables', async () => {
    const v = await vendeur('v');
    await produit(v, 'Illimité', { stockRestant: null });
    await produit(v, 'En stock', { stockRestant: 3 });
    await produit(v, 'Épuisé', { stockRestant: 0 });
    // Un carton de 6 avec 5 bouteilles : aucun format achetable.
    await produit(
      v,
      'Carton incomplet',
      { stockRestant: 5 },
      { stockConsumption: 6 },
    );
    await produit(v, 'Indisponible', { isAvailable: false });
    await produit(v, 'Retiré', { deletedAt: new Date() });
    await produit(v, 'Sur commande', { madeToOrder: true });
    await produit(v, 'Sans format', {}, null);
    // Fenêtre horaire déjà passée (00:00 → 00:01) : hors créneau à toute
    // heure sauf la première minute de la journée.
    await produit(v, 'Hors créneau', {
      availableFrom: '00:00',
      availableUntil: '00:01',
    });

    const noms = await ids({ limit: 20 });
    expect(noms.sort()).toEqual(['En stock', 'Illimité'].sort());
  });

  it('au moins un format achetable suffit (verdict par format)', async () => {
    const v = await vendeur('v');
    const p = await prisma.product.create({
      data: {
        nom: 'Jus de gingembre',
        prixOriginal: 500,
        restaurantId: v,
        stockPolicy: 'INVENTORY',
        stockRestant: 4,
        variants: {
          create: [
            { label: 'Bouteille', prix: 500, stockConsumption: 1 },
            { label: 'Pack de 6', prix: 2800, stockConsumption: 6 },
          ],
        },
      },
    });
    const [row] = (await service.findAvailableNow({})).data;
    expect(row.id).toBe(p.id);
    const verdicts = Object.fromEntries(
      row.variants.map((x) => [x.label, x.stockStatus]),
    );
    expect(verdicts['Bouteille']).not.toBe('OUT_OF_STOCK');
    expect(verdicts['Pack de 6']).toBe('OUT_OF_STOCK');
  });

  it('le produit fantôme d’un plat spécial est exclu', async () => {
    const v = await vendeur('v');
    const phantom = await prisma.product.create({
      data: {
        nom: 'Fantôme',
        prixOriginal: 2500,
        restaurantId: v,
        variants: { create: { label: 'Standard', prix: 2500 } },
      },
      include: { variants: true },
    });
    await prisma.menuDuJour.create({
      data: {
        nom: 'Plat spécial',
        prix: 2500,
        type: 'PLAT_SPECIAL',
        restaurantId: v,
        dateDebut: new Date(Date.now() - 3600_000),
        dateFin: new Date(Date.now() + 86_400_000),
        products: {
          create: {
            productId: phantom.id,
            variantId: phantom.variants[0].id,
            ordre: 0,
          },
        },
      },
    });
    await produit(v, 'Normal');

    expect(await ids({})).toEqual(['Normal']);
  });

  it('filtre vendorType', async () => {
    await produit(await vendeur('resto'), 'Poulet');
    await produit(
      await vendeur('boul', { vendorType: VendorType.BAKERY }),
      'Croissant',
    );

    expect(await ids({ vendorType: VendorType.BAKERY })).toEqual(['Croissant']);
  });

  it('classement : LIVRER des 30 derniers jours seulement', async () => {
    const v1 = await vendeur('v1');
    const v2 = await vendeur('v2');
    const v3 = await vendeur('v3');
    const v4 = await vendeur('v4');
    const livre = await produit(v1, 'Livré récemment');
    const annule = await produit(v2, 'Beaucoup annulé');
    const ancien = await produit(v3, 'Livré il y a longtemps');
    await produit(v4, 'Jamais commandé');
    await commandes(livre, v1, 2);
    await commandes(annule, v2, 10, OrderStatus.ANNULER);
    await commandes(ancien, v3, 10, OrderStatus.LIVRER, 45);

    const noms = await ids({});
    expect(noms[0]).toBe('Livré récemment');
    expect(noms).toHaveLength(4);
  });

  it('diversité : au plus 3 produits par vendeur', async () => {
    const gros = await vendeur('gros');
    for (let i = 0; i < 8; i++) {
      await commandes(await produit(gros, `Gros ${i}`), gros, 10 - i);
    }
    const petit = await vendeur('petit');
    await produit(petit, 'Petit');

    const res = (await service.findAvailableNow({ limit: 10 })).data;
    const parVendeur = res.reduce<Record<string, number>>((acc, p) => {
      acc[p.restaurantId] = (acc[p.restaurantId] ?? 0) + 1;
      return acc;
    }, {});
    expect(parVendeur).toEqual({ gros: 3, petit: 1 });
    // Les trois retenus sont les mieux classés du gros vendeur.
    expect(res.slice(0, 3).map((p) => p.nom)).toEqual([
      'Gros 0',
      'Gros 1',
      'Gros 2',
    ]);
  });

  it('aucun compteur interne dans la réponse', async () => {
    const v = await vendeur('v');
    await commandes(await produit(v, 'Star'), v, 3);

    const res = await service.findAvailableNow({});
    const json = JSON.stringify(res);
    expect(json).not.toMatch(/orderCount|score|popularity|_count/i);
    expect(res.meta.generatedAt).toEqual(expect.any(String));
  });

  it('rien d’ouvert : liste vide', async () => {
    await produit(await vendeur('f', { isOpen: false }), 'Fermé');
    expect(await service.findAvailableNow({})).toEqual({
      data: [],
      meta: { generatedAt: expect.any(String) },
    });
  });
  describe('/products/popular — compatibilité', () => {
    it('filtre avant la coupe : un produit retiré très commandé ne vide plus la liste', async () => {
      const v = await vendeur('v');
      await commandes(
        await produit(v, 'Retiré star', { deletedAt: new Date() }),
        v,
        20,
      );
      await commandes(await produit(v, 'Servable'), v, 1);

      const { data } = await service.findPopular(1);
      expect(data.map((p) => p.nom)).toEqual(['Servable']);
    });

    it('commandes annulées et impayées ignorées, orderCount conservé', async () => {
      const v = await vendeur('v');
      const a = await produit(v, 'Annulé');
      const b = await produit(v, 'Livré');
      await commandes(a, v, 5, OrderStatus.ANNULER);
      await commandes(a, v, 5, OrderStatus.EN_ATTENTE);
      await commandes(b, v, 2);

      const { data } = await service.findPopular(10);
      expect(data.map((p) => [p.nom, p.orderCount])).toEqual([['Livré', 2]]);
    });

    it('les formats portent leur verdict de stock ; le vendeur fermé reste (badge « Fermé »)', async () => {
      const f = await vendeur('f', { isOpen: false });
      await commandes(await produit(f, 'Fermé', { stockRestant: 2 }), f, 1);
      await commandes(await produit(f, 'Épuisé', { stockRestant: 0 }), f, 3);

      const { data } = await service.findPopular(10);
      expect(data.map((p) => p.nom)).toEqual(['Fermé']);
      expect(data[0].restaurant.isOpen).toBe(false);
      expect(data[0].variants[0]).toMatchObject({ availableQuantity: 2 });
    });
  });
});
