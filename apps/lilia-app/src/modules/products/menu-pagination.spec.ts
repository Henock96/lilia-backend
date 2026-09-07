import { Test, TestingModule } from '@nestjs/testing';

import { PrismaService } from '../../prisma/prisma.service';
import { RestaurantAccessService } from '../restaurants/restaurant-access.service';
import { ProductQueryService } from './product-query.service';
import { MENU_PRODUCTS_LIMIT } from './vendor-menu.include';

/**
 * **Une carte plus longue que la borne ne doit pas être tronquée en silence.**
 *
 * Le serveur servait déjà `totalProducts` et `hasMoreProducts` sur
 * `GET /restaurants/:id` — et **aucun client ne les lisait** (recherche
 * exhaustive sur les 4 dépôts, 0 occurrence). Le tri étant `createdAt desc`,
 * c'étaient les produits les plus anciens qui disparaissaient, et avec eux des
 * **sections entières** : les deux clients masquent les sections vides, si bien
 * qu'une catégorie dont tous les produits étaient au-delà du 100ᵉ rang
 * s'évaporait sans le moindre message.
 *
 * La stratégie retenue est la complétion paginée : la carte porte la première
 * page, et le client enchaîne `GET /products?restaurantId=…&page=n` jusqu'au
 * total annoncé. Elle ne tient qu'à une condition — **le même tri des deux
 * côtés** — sans quoi la page 2 ne prolonge pas la page 1.
 *
 * Ces tests simulent des catalogues de 150, 300 et 500 produits et vérifient
 * que la reconstruction client est **complète et sans doublon**.
 */
describe('Pagination du menu — catalogues de 150, 300 et 500 produits', () => {
  /** Catalogue trié comme `MENU_PRODUCTS_ORDER_BY` le ferait en SQL. */
  function catalogue(taille: number) {
    return Array.from({ length: taille }, (_, i) => ({
      id: `p${String(i).padStart(4, '0')}`,
      nom: `Produit ${i}`,
      // Un tiers du catalogue est classé par le vendeur, le reste porte le
      // défaut 1000 : c'est le cas réel après la migration.
      displayOrder: i < taille / 3 ? i : 1000,
      createdAt: new Date(2026, 0, 1, 0, 0, taille - i),
    })).sort(
      (a, b) =>
        a.displayOrder - b.displayOrder ||
        b.createdAt.getTime() - a.createdAt.getTime() ||
        a.id.localeCompare(b.id),
    );
  }

  /** Prisma mocké qui applique réellement `skip`/`take` sur le catalogue trié. */
  function prismaAvec(taille: number) {
    const rows = catalogue(taille);
    return {
      product: {
        fields: { availableFrom: 'F', availableUntil: 'U' },
        count: jest.fn().mockResolvedValue(rows.length),
        findMany: jest.fn((args: { skip?: number; take?: number }) =>
          Promise.resolve(
            rows.slice(
              args.skip ?? 0,
              (args.skip ?? 0) + (args.take ?? rows.length),
            ),
          ),
        ),
      },
      _rows: rows,
    };
  }

  async function serviceAvec(prisma: unknown) {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProductQueryService,
        { provide: PrismaService, useValue: prisma },
        { provide: RestaurantAccessService, useValue: {} },
      ],
    }).compile();
    return module.get(ProductQueryService);
  }

  /** Ce que fait un client : première page du menu, puis complétion. */
  async function reconstruire(taille: number) {
    const prisma = prismaAvec(taille);
    const service = await serviceAvec(prisma);

    // La carte embarque `MENU_PRODUCTS_LIMIT` produits (page 1 de même taille).
    const premiere = await service.findAll(
      'r1',
      undefined,
      1,
      MENU_PRODUCTS_LIMIT,
    );
    const recus = [...premiere.data];

    let page = 1;
    while (page < premiere.meta.totalPages) {
      page += 1;
      const suite = await service.findAll(
        'r1',
        undefined,
        page,
        MENU_PRODUCTS_LIMIT,
      );
      recus.push(...suite.data);
    }

    return { recus, attendus: prisma._rows, meta: premiere.meta };
  }

  it.each([150, 300, 500])(
    '%i produits — la carte reconstruite est complète, sans doublon, dans l’ordre',
    async (taille) => {
      const { recus, attendus, meta } = await reconstruire(taille);

      expect(meta.total).toBe(taille);
      expect(recus).toHaveLength(taille);
      // Sans doublon : c'est ce qu'un tri divergent entre le menu et la
      // pagination produirait en premier.
      expect(new Set(recus.map((p) => p.id)).size).toBe(taille);
      // Et dans l'ordre exact du catalogue serveur.
      expect(recus.map((p) => p.id)).toEqual(attendus.map((p) => p.id));
    },
  );

  it('aucune section ne disparaît : tous les produits classés arrivent avant les non classés', async () => {
    const { recus } = await reconstruire(300);

    const rangs = recus.map((p) => p.displayOrder);
    const dernierClasse = rangs.lastIndexOf(
      Math.max(...rangs.filter((o) => o < 1000)),
    );
    const premierNonClasse = rangs.indexOf(1000);

    expect(dernierClasse).toBeLessThan(premierNonClasse);
  });

  it('une carte plus courte que la borne tient en une seule page', async () => {
    const prisma = prismaAvec(42);
    const service = await serviceAvec(prisma);

    const res = await service.findAll('r1', undefined, 1, MENU_PRODUCTS_LIMIT);

    expect(res.meta.totalPages).toBe(1);
    expect(res.data).toHaveLength(42);
    expect(prisma.product.findMany).toHaveBeenCalledTimes(1);
  });
});
