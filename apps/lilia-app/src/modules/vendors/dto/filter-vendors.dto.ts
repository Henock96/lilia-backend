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

  /**
   * Vendeurs mis en avant par l'administration.
   *
   * C'est ce filtre que consomme la section « Les plus courus » du site, qui
   * prenait jusqu'ici les quatre premiers de la liste — c'est-à-dire les quatre
   * derniers créés. L'interface annonçait une sélection éditoriale que personne
   * ne pouvait produire.
   */
  @IsBoolean()
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  isFeatured?: boolean;

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
