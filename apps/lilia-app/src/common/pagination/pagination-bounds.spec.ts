import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';

import { MAX_PAGE_SIZE, PaginationQueryDto } from './pagination-query.dto';
import { AdminVendorFilterDto } from '../../modules/admin/dto/admin-vendor-filter.dto';
import { FilterVendorsDto } from '../../modules/vendors/dto/filter-vendors.dto';
import { ProductFilterQueryDto } from '../../modules/products/dto/product-query.dto';

/**
 * **Une** borne de pagination, pas une par module.
 *
 * `AdminVendorFilterDto` et `FilterVendorsDto` redéclaraient `page` / `limit` à
 * la main avec `@Max(50)`, quand `PaginationQueryDto` en pose 100. Rien ne
 * signalait l'écart : chaque DTO se validait parfaitement seul. Le back-office
 * demandait 100 — la valeur en vigueur partout ailleurs — et recevait un 400
 * qu'il traduisait en liste vide, d'où « aucun vendeur sélectionnable » puis
 * « Vous devez posséder un vendeur » à la création d'un produit.
 *
 * Ce test compare les DTOs **entre eux**. Un futur `@Max(200)` local le casse.
 */
describe('Bornes de pagination — une seule valeur pour toutes les listes', () => {
  // Typé `object` volontairement : le test doit échouer sur une **assertion
  // lisible** (« refuse limit=100 »), pas sur une incompatibilité de types qui
  // n'expliquerait pas ce qui est cassé.
  const PAGINATED_DTOS: Record<string, new () => object> = {
    PaginationQueryDto,
    AdminVendorFilterDto,
    FilterVendorsDto,
    ProductFilterQueryDto,
  };

  function errorsFor(Dto: new () => object, query: Record<string, string>) {
    return validateSync(plainToInstance(Dto, query));
  }

  for (const [name, Dto] of Object.entries(PAGINATED_DTOS)) {
    describe(name, () => {
      it(`accepte limit=${MAX_PAGE_SIZE}`, () => {
        expect(errorsFor(Dto, { limit: String(MAX_PAGE_SIZE) })).toHaveLength(
          0,
        );
      });

      it(`refuse limit=${MAX_PAGE_SIZE + 1}`, () => {
        expect(
          errorsFor(Dto, { limit: String(MAX_PAGE_SIZE + 1) }).length,
        ).toBeGreaterThan(0);
      });

      it('refuse une page nulle ou négative', () => {
        expect(errorsFor(Dto, { page: '0' }).length).toBeGreaterThan(0);
      });

      it('applique les défauts en l’absence de paramètres', () => {
        const dto = plainToInstance(Dto, {}) as unknown as PaginationQueryDto;
        expect(dto.page).toBe(1);
        expect(dto.limit).toBe(20);
      });
    });
  }
});
