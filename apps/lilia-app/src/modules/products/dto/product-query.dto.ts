import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { ProductType, VendorType } from '@prisma/client';

import { PaginationQueryDto } from '../../../common/pagination/pagination-query.dto';

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
