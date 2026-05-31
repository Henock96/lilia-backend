/* eslint-disable prettier/prettier */
import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { ProductType, StockMode } from '@prisma/client';

const TIME_HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

class UpdateProductVariantDto {
  @IsString()
  @IsOptional()
  id?: string; // ID existant pour mise à jour

  @IsString()
  @IsOptional()
  label?: string;

  @IsNumber()
  @IsOptional()
  prix?: number;
}

export class UpdateProductDto {
  @IsString()
  @IsOptional()
  nom?: string;

  @IsString()
  @IsOptional()
  description?: string;

  @IsUrl()
  @IsOptional()
  imageUrl?: string;

  @IsNumber()
  @IsOptional()
  prixOriginal?: number;

  @IsString()
  @IsOptional()
  categoryId?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => UpdateProductVariantDto)
  @IsOptional()
  variants?: UpdateProductVariantDto[];

  // Multi-vendeurs (LIL-114)
  @IsEnum(ProductType)
  @IsOptional()
  productType?: ProductType;

  @IsEnum(StockMode)
  @IsOptional()
  stockMode?: StockMode;

  @IsString()
  @IsOptional()
  @MaxLength(1000)
  ingredients?: string;

  @IsInt()
  @IsOptional()
  @Min(1)
  shelfLifeDays?: number;

  @IsBoolean()
  @IsOptional()
  madeToOrder?: boolean;

  @IsString()
  @IsOptional()
  @Matches(TIME_HHMM, { message: 'availableFrom doit être au format HH:mm' })
  availableFrom?: string;

  @IsString()
  @IsOptional()
  @Matches(TIME_HHMM, { message: 'availableUntil doit être au format HH:mm' })
  availableUntil?: string;
}
