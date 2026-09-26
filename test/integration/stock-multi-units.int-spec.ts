import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

import { StockService } from '../../apps/lilia-app/src/modules/orders/stock.service';

/**
 * F3-10 — stock multi-unités, sur un vrai PostgreSQL.
 *
 * Référence de la discovery :
 *
 *   Vin Rouge X — 60 bouteilles
 *   Bouteille (consomme 1) · Carton de 6 (consomme 6)
 *   1 carton de 6 + 2 bouteilles → 60 − 8 = 52
 *
 * Ce que ces tests prouvent, et qu'aucun mock ne peut prouver :
 * - bouteille et carton puisent dans **un seul** compteur : sous concurrence,
 *   aucune combinaison ne vend plus que le stock, jamais de négatif ;
 * - les verrous sont pris dans un ordre total : deux paniers croisés ne
 *   s'interbloquent pas ;
 * - la restitution rend le figé, selon la politique (quota du jour, stock réel) ;
 * - les invariants posés par la migration tiennent (trigger, CHECK, FK).
 */
const DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

describeIfDb('F3-10 — stock multi-unités (PostgreSQL réel)', () => {
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
                     "Restaurant", "User"
      RESTART IDENTITY CASCADE
    `);
    await prisma.user.create({
      data: { id: 'u1', firebaseUid: 'fb-u1', email: 'u1@test.local' },
    });
    await prisma.restaurant.create({
      data: {
        id: 'bar',
        nom: 'Bar à vin',
        adresse: 'Poto-Poto',
        phone: '060000070',
        ownerId: 'u1',
      },
    });
  });

  async function wine(
    stockRestant: number | null,
    policy: 'INVENTORY' | 'DAILY_QUOTA' | 'UNLIMITED' = 'INVENTORY',
    id = 'vin',
  ) {
    await prisma.product.create({
      data: {
        id,
        nom: `Vin ${id}`,
        prixOriginal: 13000,
        restaurantId: 'bar',
        stockPolicy: policy,
        stockUnit: 'BOTTLE',
        stockQuotidien: stockRestant,
        stockRestant,
        variants: {
          create: [
            {
              id: `${id}-b`,
              label: 'Bouteille',
              prix: 13000,
              stockConsumption: 1,
            },
            {
              id: `${id}-c6`,
              label: 'Carton de 6',
              prix: 70000,
              stockConsumption: 6,
            },
          ],
        },
      },
    });
  }

  const B = { stockConsumption: 1, label: 'Bouteille' };
  const C6 = { stockConsumption: 6, label: 'Carton de 6' };
  const line = (
    quantite: number,
    variant: typeof B,
    productId = 'vin',
    menuId: string | null = null,
  ) => ({
    productId,
    menuId,
    quantite,
    variant,
    variantId: `${productId}-${variant === B ? 'b' : 'c6'}`,
    product: { nom: `Vin ${productId}` },
  });

  const remaining = async (id = 'vin') =>
    (await prisma.product.findUniqueOrThrow({ where: { id } })).stockRestant;

  /** Réserve dans sa propre transaction ; `true` si la réservation a abouti. */
  const reserve = (lines: ReturnType<typeof line>[]) =>
    prisma
      .$transaction((tx) => stock.decrementInTransaction(tx, lines))
      .then(
        () => true,
        (error: { response?: { code?: string } }) => {
          // Seul refus admissible : la rupture, nominative. Un interblocage
          // (40P01) ou toute autre erreur fait échouer le test.
          if (error.response?.code !== 'OUT_OF_STOCK') throw error;
          return false;
        },
      );

  it('référence : 1 carton de 6 + 2 bouteilles → 60 − 8 = 52', async () => {
    await wine(60);
    await expect(reserve([line(1, C6), line(2, B)])).resolves.toBe(true);
    expect(await remaining()).toBe(52);
  });

  it('refus nominatif dans l’unité du format demandé', async () => {
    await wine(5);
    await expect(
      prisma.$transaction((tx) =>
        stock.decrementInTransaction(tx, [line(1, C6)]),
      ),
    ).rejects.toMatchObject({
      response: {
        code: 'OUT_OF_STOCK',
        availableQuantity: 0,
        productId: 'vin',
      },
    });
    expect(await remaining()).toBe(5);
  });

  it('stock 6 : un carton ∥ une bouteille — un seul gagne, jamais 7 vendues', async () => {
    for (let round = 0; round < 10; round++) {
      await prisma.product.deleteMany();
      await wine(6);
      const [a, b] = await Promise.all([
        reserve([line(1, C6)]),
        reserve([line(1, B)]),
      ]);
      expect([a, b].filter(Boolean)).toHaveLength(1);
      expect([0, 5]).toContain(await remaining());
    }
  });

  it('stock 12 : 2 cartons ∥ 1 bouteille ∥ 6 bouteilles — Σ vendu ≤ 12, stock = 12 − Σ', async () => {
    for (let round = 0; round < 10; round++) {
      await prisma.product.deleteMany();
      await wine(12);
      const demands = [[line(2, C6)], [line(1, B)], [line(6, B)]];
      const units = [12, 1, 6];
      const results = await Promise.all(demands.map(reserve));
      const sold = results.reduce((sum, ok, i) => sum + (ok ? units[i] : 0), 0);
      expect(sold).toBeLessThanOrEqual(12);
      expect(await remaining()).toBe(12 - sold);
    }
  });

  it('20 réservations d’une bouteille sur un stock de 10 : exactement 10 succès', async () => {
    await wine(10);
    const results = await Promise.all(
      Array.from({ length: 20 }, () => reserve([line(1, B)])),
    );
    expect(results.filter(Boolean)).toHaveLength(10);
    expect(await remaining()).toBe(0);
  });

  it('paniers croisés (A puis B ∥ B puis A) : aucun interblocage', async () => {
    await wine(1000, 'INVENTORY', 'vin-a');
    await wine(1000, 'INVENTORY', 'vin-b');
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        reserve(
          i % 2
            ? [line(1, B, 'vin-a'), line(1, C6, 'vin-b')]
            : [line(1, C6, 'vin-b'), line(1, B, 'vin-a')],
        ),
      ),
    );
    expect(results.every(Boolean)).toBe(true);
    expect(await remaining('vin-a')).toBe(980);
    expect(await remaining('vin-b')).toBe(880);
  });

  describe('figé de la commande et restitution', () => {
    async function order(id: string, createdAt = new Date()) {
      await prisma.order.create({
        data: {
          id,
          userId: 'u1',
          restaurantId: 'bar',
          subTotal: 96000,
          deliveryFee: 0,
          total: 96000,
          paymentMethod: 'MTN_MOMO',
          createdAt,
          items: {
            create: [
              {
                productId: 'vin',
                variant: 'Carton de 6',
                variantId: 'vin-c6',
                quantite: 1,
                prix: 70000,
                stockUnitsPerItem: 6,
              },
              {
                productId: 'vin',
                variant: 'Bouteille',
                variantId: 'vin-b',
                quantite: 2,
                prix: 13000,
                stockUnitsPerItem: 1,
              },
            ],
          },
        },
      });
    }
    const items = (orderId: string) =>
      prisma.orderItem.findMany({
        where: { orderId },
        orderBy: { prix: 'desc' },
      });

    it('la réservation fige 6 et 2 ; l’annulation rend exactement 8', async () => {
      await wine(60);
      await order('o1');
      await prisma.$transaction(async (tx) => {
        const { limitedProductIds } = await stock.decrementInTransaction(tx, [
          line(1, C6),
          line(2, B),
        ]);
        await stock.recordReservation(tx, 'o1', limitedProductIds);
      });
      expect((await items('o1')).map((i) => i.stockUnitsReserved)).toEqual([
        6, 2,
      ]);
      expect(await remaining()).toBe(52);

      await prisma.$transaction(async (tx) =>
        stock.restoreInTransaction(
          tx,
          await tx.orderItem.findMany({ where: { orderId: 'o1' } }),
        ),
      );
      expect(await remaining()).toBe(60);
    });

    it('produit illimité au checkout, limité ensuite : rien de « rendu » qui n’a pas été pris', async () => {
      await wine(null, 'UNLIMITED');
      await order('o2');
      await prisma.$transaction(async (tx) => {
        const r = await stock.decrementInTransaction(tx, [line(1, C6)]);
        await stock.recordReservation(tx, 'o2', r.limitedProductIds);
      });
      expect((await items('o2')).map((i) => i.stockUnitsReserved)).toEqual([
        0, 0,
      ]);
      await prisma.product.update({
        where: { id: 'vin' },
        data: { stockPolicy: 'INVENTORY', stockRestant: 3, stockQuotidien: 3 },
      });
      await prisma.$transaction(async (tx) =>
        stock.restoreInTransaction(
          tx,
          await tx.orderItem.findMany({ where: { orderId: 'o2' } }),
        ),
      );
      expect(await remaining()).toBe(3);
    });

    it('commande antérieure à F3-10 (figé NULL) : ancienne règle, quantite rendue', async () => {
      await wine(10);
      await prisma.$transaction((tx) =>
        stock.restoreInTransaction(tx, [
          { productId: 'vin', quantite: 2, stockUnitsReserved: null },
        ]),
      );
      expect(await remaining()).toBe(12);
    });

    it('quota du jour : une réservation antérieure au reset n’est pas rendue', async () => {
      await wine(20, 'DAILY_QUOTA');
      const resetAt = new Date();
      await prisma.product.update({
        where: { id: 'vin' },
        data: { stockRestant: 17, stockResetAt: resetAt },
      });
      const yesterday = new Date(resetAt.getTime() - 20 * 3600_000);
      await prisma.$transaction((tx) =>
        stock.restoreInTransaction(
          tx,
          [{ productId: 'vin', quantite: 5, stockUnitsReserved: 5 }],
          { orderCreatedAt: yesterday },
        ),
      );
      expect(await remaining()).toBe(17);

      const afterReset = new Date(resetAt.getTime() + 60_000);
      await prisma.$transaction((tx) =>
        stock.restoreInTransaction(
          tx,
          [{ productId: 'vin', quantite: 2, stockUnitsReserved: 2 }],
          { orderCreatedAt: afterReset },
        ),
      );
      expect(await remaining()).toBe(19);
    });

    it('stock réel : restitution exacte, sans plafond au dernier niveau déclaré', async () => {
      await wine(60);
      await prisma.product.update({
        where: { id: 'vin' },
        data: { stockRestant: 60, stockQuotidien: 10 },
      });
      await prisma.$transaction((tx) =>
        stock.restoreInTransaction(tx, [
          { productId: 'vin', quantite: 1, stockUnitsReserved: 6 },
        ]),
      );
      expect(await remaining()).toBe(66);
    });

    it('refus « rupture » : le produit désigné passe à 0 au lieu d’être rendu', async () => {
      await wine(10);
      await wine(10, 'INVENTORY', 'autre');
      await prisma.$transaction(async (tx) => {
        await stock.restoreInTransaction(
          tx,
          [
            { productId: 'vin', quantite: 1, stockUnitsReserved: 6 },
            { productId: 'autre', quantite: 1, stockUnitsReserved: 1 },
          ],
          { zeroProductIds: ['vin'] },
        );
        await stock.markOutOfStock(tx, 'bar', ['vin']);
      });
      expect(await remaining('vin')).toBe(0);
      expect(await remaining('autre')).toBe(11);
    });
  });

  describe('menus', () => {
    async function menu(stockRestant: number | null) {
      await prisma.menuDuJour.create({
        data: {
          id: 'm1',
          nom: 'Carton découverte',
          prix: 65000,
          restaurantId: 'bar',
          stockQuotidien: stockRestant,
          stockRestant,
          dateDebut: new Date(Date.now() - 3600_000),
          dateFin: new Date(Date.now() + 3600_000),
          products: { create: { productId: 'vin', variantId: 'vin-c6' } },
        },
      });
    }

    it('un menu consomme le format désigné × le nombre de menus, et 1 menu (pas N)', async () => {
      await wine(60);
      await menu(5);
      await expect(reserve([line(2, C6, 'vin', 'm1')])).resolves.toBe(true);
      expect(await remaining()).toBe(48);
      expect(
        (await prisma.menuDuJour.findUniqueOrThrow({ where: { id: 'm1' } }))
          .stockRestant,
      ).toBe(3);
    });

    it('le format d’un composant de menu doit appartenir à son produit (FK composite)', async () => {
      await wine(60);
      await wine(60, 'INVENTORY', 'autre');
      await expect(
        prisma.menuDuJour.create({
          data: {
            nom: 'Menu piégé',
            prix: 1,
            restaurantId: 'bar',
            dateDebut: new Date(),
            dateFin: new Date(Date.now() + 3600_000),
            products: { create: { productId: 'vin', variantId: 'autre-c6' } },
          },
        }),
      ).rejects.toThrow();
    });
  });

  describe('invariants posés par la migration', () => {
    it('la consommation d’un format est immuable (trigger)', async () => {
      await wine(60);
      await expect(
        prisma.productVariant.update({
          where: { id: 'vin-c6' },
          data: { stockConsumption: 12 },
        }),
      ).rejects.toThrow(
        /stockConsumption est immuable|stock_consumption_immutable/,
      );
    });

    it('consommation hors bornes refusée', async () => {
      await wine(60);
      await expect(
        prisma.productVariant.create({
          data: {
            label: 'Rien',
            prix: 0,
            productId: 'vin',
            stockConsumption: 0,
          },
        }),
      ).rejects.toThrow(/ProductVariant_stock_consumption_range/);
    });

    it('politique et compteurs ne se contredisent pas', async () => {
      await expect(
        prisma.product.create({
          data: {
            nom: 'Incohérent',
            prixOriginal: 1,
            restaurantId: 'bar',
            stockPolicy: 'UNLIMITED',
            stockRestant: 5,
          },
        }),
      ).rejects.toThrow(/Product_stock_policy_consistent/);
    });

    it('une ligne de panier ne peut pas associer le format d’un autre produit', async () => {
      await wine(60);
      await wine(60, 'INVENTORY', 'autre');
      const cart = await prisma.cart.create({ data: { userId: 'u1' } });
      await expect(
        prisma.cartItem.create({
          data: {
            cartId: cart.id,
            productId: 'vin',
            variantId: 'autre-b',
            quantite: 1,
          },
        }),
      ).rejects.toThrow();
    });

    it('le figé réservé ne dépasse pas quantite × consommation', async () => {
      await wine(60);
      await expect(
        prisma.order.create({
          data: {
            userId: 'u1',
            restaurantId: 'bar',
            subTotal: 1,
            deliveryFee: 0,
            total: 1,
            paymentMethod: 'MTN_MOMO',
            items: {
              create: {
                productId: 'vin',
                variant: 'Carton de 6',
                quantite: 1,
                prix: 70000,
                stockUnitsPerItem: 6,
                stockUnitsReserved: 7,
              },
            },
          },
        }),
      ).rejects.toThrow(/OrderItem_stock_units_valid/);
    });
  });
});
