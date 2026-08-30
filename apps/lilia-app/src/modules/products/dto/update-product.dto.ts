import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { ProductType, StockMode } from '@prisma/client';
import { MAX_PRIX_XAF } from './create-product.dto';

const TIME_HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

class UpdateProductVariantDto {
  @IsString()
  @IsOptional()
  id?: string; // ID existant pour mise à jour

  @IsString()
  @IsOptional()
  label?: string;

  // Mêmes bornes qu'à la création (fix H3) : sans elles, la mise à jour était
  // un chemin de contournement complet.
  @IsInt({
    message:
      'Un montant en francs CFA est un nombre entier — le XAF n’a pas de sous-unité.',
  })
  @IsOptional()
  @Min(0, { message: 'Le prix ne peut pas être négatif.' })
  @Max(MAX_PRIX_XAF, { message: 'Prix hors limites.' })
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

  @IsInt({
    message:
      'Un montant en francs CFA est un nombre entier — le XAF n’a pas de sous-unité.',
  })
  @IsOptional()
  @Min(0, { message: 'Le prix ne peut pas être négatif.' })
  @Max(MAX_PRIX_XAF, { message: 'Prix hors limites.' })
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
