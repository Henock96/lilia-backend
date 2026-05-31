/* eslint-disable prettier/prettier */
import { Transform } from 'class-transformer';
import { IsBoolean, IsEnum, IsInt, IsOptional, Max, Min } from 'class-validator';
import { VendorType } from '@prisma/client';

// Note : filtre `quartier` reporté au Sprint C — il dépend de la logique
// deliveryZones (ZONE_BASED) vs FIXED qui mérite sa propre décision produit.
export class FilterVendorsDto {
  @IsEnum(VendorType)
  @IsOptional()
  vendorType?: VendorType;

  @IsBoolean()
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  isOpen?: boolean;

  @IsInt()
  @IsOptional()
  @Min(1)
  @Transform(({ value }) => parseInt(value, 10))
  page?: number = 1;

  @IsInt()
  @IsOptional()
  @Min(1)
  @Max(50)
  @Transform(({ value }) => parseInt(value, 10))
  limit?: number = 20;
}
