import { Transform } from 'class-transformer';
import { IsBoolean, IsEnum, IsOptional } from 'class-validator';
import { VendorType } from '@prisma/client';

import { PaginationQueryDto } from '../../../common/pagination/pagination-query.dto';

/**
 * Filtres de `GET /admin/vendors`.
 *
 * ⚠️ `page` / `limit` étaient redéclarés ici à la main, avec `@Max(50)` — alors
 * que `PaginationQueryDto` porte la borne commune `MAX_PAGE_SIZE` (100) et son
 * message français. Deux plafonds pour la même notion, et rien pour dire lequel
 * fait foi : le back-office demandait 100 (comme partout ailleurs) et recevait
 * un **400 « limit must not be greater than 50 »**, avalé en liste vide par le
 * front. L'administrateur voyait alors « aucun vendeur », donc aucun vendeur
 * cible pour ses écritures — et `POST /products` repartait sans `restaurantId`,
 * pour finir en 403 « Vous devez posséder un vendeur ».
 *
 * La borne d'une liste appartient à `PaginationQueryDto`, pas à chaque filtre.
 */
export class AdminVendorFilterDto extends PaginationQueryDto {
  @IsEnum(VendorType)
  @IsOptional()
  vendorType?: VendorType;

  @IsBoolean()
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  adminApproved?: boolean;

  @IsBoolean()
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  isActive?: boolean;
}
