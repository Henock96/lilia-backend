/* eslint-disable prettier/prettier */
import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
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

class CreateProductVariantDto {
  @IsString()
  @IsOptional()
  label?: string; // e.g., "30cl", "Grand"

  @IsNumber()
  @IsNotEmpty()
  prix: number;
}

export class CreateProductDto {
  @IsString()
  @IsNotEmpty()
  nom: string;

  @IsString()
  @IsOptional()
  description?: string;

  @IsUrl()
  @IsOptional()
  imageUrl?: string;

  @IsNumber()
  @IsNotEmpty()
  prixOriginal: number;

  @IsString()
  @IsOptional()
  categoryId?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateProductVariantDto)
  @IsOptional()
  variants?: CreateProductVariantDto[];

  // Multi-vendeurs (LIL-114)
  // Défaut FOOD pour préserver le comportement historique des restaurants.
  // ALCOHOL est dans l'enum mais rejeté au lancement (cf. ProductValidator).
  @IsEnum(ProductType)
  @IsOptional()
  productType?: ProductType;

  // DAILY = reset chaque nuit (plats du jour), PERMANENT = stock réel.
  @IsEnum(StockMode)
  @IsOptional()
  stockMode?: StockMode;

  @IsInt()
  @IsOptional()
  @Min(0)
  stockQuotidien?: number;

  // Fait maison / pâtisserie
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

  // Disponibilité horaire (BAKERY surtout — ex: viennoiseries du matin)
  @IsString()
  @IsOptional()
  @Matches(TIME_HHMM, { message: 'availableFrom doit être au format HH:mm' })
  availableFrom?: string;

  @IsString()
  @IsOptional()
  @Matches(TIME_HHMM, { message: 'availableUntil doit être au format HH:mm' })
  availableUntil?: string;
}
