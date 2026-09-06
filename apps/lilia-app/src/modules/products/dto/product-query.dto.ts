import { IsEnum, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { ProductType, VendorType } from '@prisma/client';

import { PaginationQueryDto } from '../../../common/pagination/pagination-query.dto';
import type { StockStatus } from '../stock-status';

/** Filtres du catalogue public `GET /products`, pagination bornée incluse. */
export class ProductFilterQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  restaurantId?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  categoryId?: string;

  @ApiPropertyOptional({ enum: ProductType })
  @IsEnum(ProductType)
  @IsOptional()
  productType?: ProductType;

  @ApiPropertyOptional({ enum: VendorType })
  @IsEnum(VendorType)
  @IsOptional()
  vendorType?: VendorType;

  /**
   * Filtre de stock — **vue gestionnaire uniquement** (`GET /products/manage`).
   *
   * `@IsIn` et non un type TypeScript seul : l'annotation ne vaut rien à
   * l'exécution, et une valeur inconnue doit donner un 400 explicite plutôt
   * qu'un filtre silencieusement ignoré — un filtre qui ne filtre pas est pire
   * qu'un filtre absent, il fait croire que le catalogue est sain.
   */
  @ApiPropertyOptional({ enum: ['out', 'low', 'unlimited', 'tracked'] })
  @IsIn(['out', 'low', 'unlimited', 'tracked'], {
    message: 'stockStatus doit valoir out, low, unlimited ou tracked.',
  })
  @IsOptional()
  stockStatus?: StockStatus;
}

/** `GET /products/search` — la requête est bornée pour éviter les scans full-text absurdes. */
export class ProductSearchQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ maxLength: 100 })
  @IsString()
  @MaxLength(100, { message: 'La recherche est limitée à 100 caractères' })
  @IsOptional()
  @Type(() => String)
  q: string = '';
}
