import { OnboardingStatus } from '@prisma/client';

import { ProductQueryService } from './product-query.service';
import {
  PUBLIC_VENDOR_ORDER_BY,
  PUBLIC_VENDOR_WHERE,
} from '../../common/vendor-visibility';

/**
 * Frontière marketplace des **cinq** lectures publiques du catalogue.
 *
 * `PUBLIC_VENDOR_WHERE` existe parce que la règle « ce vendeur est visible d'un
 * client » était recopiée à la main sur quatorze requêtes. `findAll` — la plus
 * empruntée des cinq — en portait encore une copie **incomplète** : `isActive`
 * et `adminApproved`, sans `onboardingStatus: ACTIVATED`. Le catalogue d'un
 * commerce en cours de configuration était donc lisible sans authentification,
 * alors que le commerce lui-même restait absent de toutes les listes.
 *
 * Le test compare chaque requête à la constante plutôt qu'à une liste de
 * champs : ajouter demain une quatrième condition à `PUBLIC_VENDOR_WHERE` doit
 * la propager partout, sans qu'on ait à se souvenir de ce fichier.
 */
describe('Lectures publiques du catalogue — frontière marketplace', () => {
  function build() {
    const findMany = jest.fn().mockResolvedValue([]);
    const count = jest.fn().mockResolvedValue(0);
    const groupBy = jest.fn().mockResolvedValue([]);
    const prisma = {
      product: {
        findMany,
        count,
        fields: { availableFrom: 'F', availableUntil: 'U' },
      },
      restaurant: { findMany: jest.fn().mockResolvedValue([]) },
      orderItem: { groupBy },
      user: { findUnique: jest.fn().mockResolvedValue(null) },
    };
    const access = { resolveTargetRestaurant: jest.fn() };
    return {
      service: new ProductQueryService(prisma as never, access as never),
      findMany,
      prisma,
    };
  }

  it('findAll applique la frontière complète, pas une copie partielle', async () => {
    const { service, findMany } = build();
    await service.findAll('resto-a');

    const where = findMany.mock.calls[0][0].where as Record<string, unknown>;
    expect(where.restaurant).toMatchObject(PUBLIC_VENDOR_WHERE);
    // La condition dont l'absence exposait les vendeurs en cours d'onboarding.
    expect((where.restaurant as Record<string, unknown>).onboardingStatus).toBe(
      OnboardingStatus.ACTIVATED,
    );
  });

  it('findAll conserve le filtre vendorType par-dessus la frontière', async () => {
    const { service, findMany } = build();
    await service.findAll(undefined, undefined, 1, 20, undefined, 'BAKERY');

    const restaurant = (
      findMany.mock.calls[0][0].where as Record<string, unknown>
    ).restaurant as Record<string, unknown>;
    expect(restaurant).toMatchObject({
      ...PUBLIC_VENDOR_WHERE,
      vendorType: 'BAKERY',
    });
  });

  it('findPopular applique la même frontière', async () => {
    const { service, findMany, prisma } = build();
    prisma.orderItem.groupBy.mockResolvedValue([
      { productId: 'p1', _count: { productId: 3 } },
    ]);

    await service.findPopular(10);

    const where = findMany.mock.calls[0][0].where as Record<string, unknown>;
    expect(where.restaurant).toEqual(PUBLIC_VENDOR_WHERE);
  });

  it('search applique la même frontière aux produits', async () => {
    const { service, findMany } = build();
    await service.search('poulet');

    const where = findMany.mock.calls[0][0].where as Record<string, unknown>;
    expect(where.restaurant).toEqual(PUBLIC_VENDOR_WHERE);
  });

  /**
   * La recherche coupe à `limit` (20) : sans tri, l'ordre était celui du tas
   * PostgreSQL. Vérifié en production le 03/10/2026 — « poulet » rendait 20
   * plats, 12 de boutiques fermées intercalés avec les 8 commandables, et
   * rien ne garantissait que les commandables survivent à la coupe.
   */
  it('search classe les boutiques ouvertes d’abord, avant la coupe', async () => {
    const { service, findMany, prisma } = build();
    await service.search('poulet');

    const products = findMany.mock.calls[0][0] as {
      orderBy: Record<string, unknown>[];
    };
    expect(products.orderBy.slice(0, PUBLIC_VENDOR_ORDER_BY.length)).toEqual(
      PUBLIC_VENDOR_ORDER_BY.map((o) => ({ restaurant: o })),
    );

    const vendors = prisma.restaurant.findMany.mock.calls[0][0] as {
      orderBy: unknown[];
    };
    expect(vendors.orderBy).toEqual([...PUBLIC_VENDOR_ORDER_BY]);
  });

  /**
   * Un résultat de recherche est rendu par la même carte qu'un produit du
   * menu : il doit porter les mêmes verdicts serveur — fenêtre de vente
   * (`availableNow`) et stock **par format** (`stockStatus`). Sans eux,
   * l'application recalculait la fenêtre avec l'heure du téléphone et
   * proposait d'ajouter un format épuisé.
   */
  it('search sert les verdicts serveur : availableNow et stock par format', async () => {
    const { service, findMany } = build();
    findMany.mockResolvedValue([
      {
        id: 'p1',
        nom: 'Poulet braisé',
        availableFrom: '11:00',
        availableUntil: '11:01',
        stockRestant: 1,
        variants: [
          { id: 'v1', stockConsumption: 1 },
          { id: 'v2', stockConsumption: 2 },
        ],
        restaurant: { id: 'r1', nom: 'Chez Lili', isOpen: true },
      },
    ]);

    const { products } = await service.search('poulet');

    expect(products[0]).toHaveProperty('availableNow');
    expect(typeof products[0].availableNow).toBe('boolean');
    expect(products[0].variants.map((v) => v.stockStatus)).toEqual([
      'LOW',
      'OUT_OF_STOCK',
    ]);
  });

  it('findAvailableNow applique la frontière, l’ouverture et le vendorType avant toute coupe', async () => {
    const { service, findMany } = build();
    await service.findAvailableNow({ vendorType: 'BAKERY', limit: 10 });

    const args = findMany.mock.calls[0][0] as {
      where: Record<string, unknown>;
      take: number;
    };
    expect(args.where.restaurant).toEqual({
      ...PUBLIC_VENDOR_WHERE,
      isOpen: true,
      vendorType: 'BAKERY',
    });
    // La coupe au `limit` demandé n'a pas lieu en SQL : le plafond des
    // candidats est bien au-dessus, le filtre de stock exact vient après.
    expect(args.take).toBeGreaterThan(10);
  });
});
