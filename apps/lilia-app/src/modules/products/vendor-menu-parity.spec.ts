import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { PrismaService } from '../../prisma/prisma.service';
import { PaginationService } from '../../common/pagination/pagination.service';
import { AdminAuditService } from '../admin-audit/admin-audit.service';
import { RestaurantAccessService } from '../restaurants/restaurant-access.service';
import { RestaurantQueryService } from '../restaurants/restaurant-query.service';
import { VendorsService } from '../vendors/vendors.service';
import { ProductQueryService } from './product-query.service';
import {
  MENU_PRODUCTS_LIMIT,
  MENU_PRODUCTS_ORDER_BY,
  MENU_VARIANTS_ORDER_BY,
} from './vendor-menu.include';

/**
 * **Le garde-fou de la phase 2.**
 *
 * `GET /restaurants/:id` et `GET /vendors/:id` répondent à la même question —
 * « que vend ce commerçant ? ». Elles la construisaient séparément, et avaient
 * divergé sur six points, mesurés en production le 06/09/2026 :
 *
 * | | `/restaurants/:id` (site) | `/vendors/:id` (application) |
 * |---|---|---|
 * | produits épuisés | inclus | **exclus** |
 * | `take` | 100 | **aucun** |
 * | `orderBy` produits | `createdAt desc` | **aucun** |
 * | menus du jour | absents | inclus |
 * | note moyenne | calculée | **absente** |
 * | `totalProducts` / `hasMoreProducts` | servis | absents |
 *
 * Rien ne pouvait l'attraper : chaque service avait ses propres tests, et
 * chacun passait. **Ce n'est pas un service qu'il faut tester ici, c'est
 * l'accord entre deux.**
 *
 * Ce fichier appelle réellement les deux méthodes avec un Prisma mocké qui
 * capture les arguments, et compare le bloc catalogue clé par clé. Il échoue
 * dès qu'une des deux routes s'écarte — y compris si quelqu'un « optimise »
 * l'une d'elles en recopiant l'include au lieu de l'importer.
 *
 * Tant que les deux routes coexistent (le panier du site et l'écran de réglages
 * de l'admin lisent `/restaurants/:id` pour ses frais de livraison et ses
 * horaires, pas pour son catalogue), ce test est ce qui les tient ensemble.
 */
describe('Parité de la carte — GET /vendors/:id vs GET /restaurants/:id', () => {
  const VENDEUR = {
    id: 'v1',
    nom: 'Chez Maman Lili',
    products: [],
    menuDuJour: [],
    _count: { products: 3 },
  };

  const prisma = {
    restaurant: { findFirst: jest.fn() },
    review: { groupBy: jest.fn() },
    product: { fields: { availableFrom: 'F', availableUntil: 'U' } },
  };

  let vendors: VendorsService;
  let restaurants: RestaurantQueryService;

  beforeEach(async () => {
    jest.clearAllMocks();
    prisma.restaurant.findFirst.mockResolvedValue(VENDEUR);
    prisma.review.groupBy.mockResolvedValue([]);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VendorsService,
        RestaurantQueryService,
        { provide: PrismaService, useValue: prisma },
        { provide: PaginationService, useValue: {} },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
        { provide: AdminAuditService, useValue: { record: jest.fn() } },
      ],
    }).compile();

    vendors = module.get(VendorsService);
    restaurants = module.get(RestaurantQueryService);
  });

  /** Les deux `include`, capturés en appelant réellement les deux services. */
  async function bothIncludes() {
    await vendors.findOne('v1');
    const fromVendors = prisma.restaurant.findFirst.mock.calls[0][0].include;

    prisma.restaurant.findFirst.mockClear();
    await restaurants.findOne('v1');
    const fromRestaurants =
      prisma.restaurant.findFirst.mock.calls[0][0].include;

    return { fromVendors, fromRestaurants };
  }

  it('sert exactement les mêmes produits, dans le même ordre, avec la même borne', async () => {
    const { fromVendors, fromRestaurants } = await bothIncludes();

    // `where`, `include`, `orderBy` et `take` — la comparaison porte sur le
    // bloc entier, pas sur une liste de champs qu'il faudrait penser à
    // rallonger à chaque évolution.
    expect(fromRestaurants.products).toEqual(fromVendors.products);
  });

  it('sert les mêmes sections de menu', async () => {
    const { fromVendors, fromRestaurants } = await bothIncludes();
    expect(fromRestaurants.categories).toEqual(fromVendors.categories);
  });

  it('sert les mêmes menus du jour — le site n’en servait aucun', async () => {
    const { fromVendors, fromRestaurants } = await bothIncludes();

    expect(fromVendors.menuDuJour).toBeDefined();
    expect(fromRestaurants.menuDuJour).toEqual(fromVendors.menuDuJour);
  });

  it('compte les produits de la carte de la même façon', async () => {
    const { fromVendors, fromRestaurants } = await bothIncludes();
    expect(fromRestaurants._count).toEqual(fromVendors._count);
  });

  it('rend les mêmes champs dérivés (note, totaux, availableNow)', async () => {
    prisma.review.groupBy.mockResolvedValue([
      { restaurantId: 'v1', _avg: { rating: 4.6 }, _count: { rating: 5 } },
    ]);

    const fromVendors = (await vendors.findOne('v1')).data;
    const fromRestaurants = (await restaurants.findOne('v1')).data;

    for (const key of [
      'averageRating',
      'totalReviews',
      'totalProducts',
      'hasMoreProducts',
    ] as const) {
      expect(fromRestaurants[key]).toEqual(fromVendors[key]);
    }
  });

  /**
   * Les invariants **écrits à la main**.
   *
   * Le test d'égalité ci-dessus vérifie que les deux routes sont d'accord ; il
   * ne dit rien de *ce sur quoi* elles sont d'accord. Deux routes également
   * fausses le passeraient. C'est la même leçon que la spec « exhaustive » de
   * la machine à états, qui dérivait ses attentes de la matrice qu'elle était
   * censée valider : **toute règle métier doit avoir sa ligne écrite en dur.**
   */
  describe('invariants du contrat de menu', () => {
    it('les produits épuisés restent dans la carte', async () => {
      const { fromVendors } = await bothIncludes();
      expect(JSON.stringify(fromVendors.products.where)).not.toContain(
        'stockRestant',
      );
    });

    it('les produits retirés et indisponibles en sortent', async () => {
      const { fromVendors } = await bothIncludes();
      expect(fromVendors.products.where.deletedAt).toBeNull();
      expect(fromVendors.products.where.isAvailable).toBe(true);
    });

    it("l'ordre est explicite et déterministe", async () => {
      const { fromVendors } = await bothIncludes();
      expect(fromVendors.products.orderBy).toEqual([...MENU_PRODUCTS_ORDER_BY]);
      expect(fromVendors.products.include.variants.orderBy).toEqual([
        ...MENU_VARIANTS_ORDER_BY,
      ]);
    });

    it('la carte est bornée', async () => {
      const { fromVendors } = await bothIncludes();
      expect(fromVendors.products.take).toBe(MENU_PRODUCTS_LIMIT);
    });
  });

  /**
   * `GET /products` est la route par laquelle les clients **complètent** une
   * carte dépassant `MENU_PRODUCTS_LIMIT`. Si son tri diffère de celui du menu,
   * la page 2 ne prolonge pas la page 1 : des produits réapparaissent, d'autres
   * disparaissent, et la carte est fausse sans qu'aucune erreur ne se produise.
   */
  it('la pagination de complétion trie comme la carte', async () => {
    const productPrisma = {
      product: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        fields: prisma.product.fields,
      },
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProductQueryService,
        { provide: PrismaService, useValue: productPrisma },
        { provide: RestaurantAccessService, useValue: {} },
      ],
    }).compile();

    await module.get(ProductQueryService).findAll('v1');

    const args = productPrisma.product.findMany.mock.calls[0][0];
    expect(args.orderBy).toEqual([...MENU_PRODUCTS_ORDER_BY]);
    expect(args.include.variants.orderBy).toEqual([...MENU_VARIANTS_ORDER_BY]);
  });
});
