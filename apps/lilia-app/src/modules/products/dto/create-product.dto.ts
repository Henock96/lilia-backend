import { Type } from 'class-transformer';
import {
  IsArray,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUrl,
  ValidateNested,
} from 'class-validator';

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
}
