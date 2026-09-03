import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
  Min,
} from 'class-validator';
import { Transform } from 'class-transformer';

import { CATEGORY_NAME_MAX_LENGTH } from '../category-slug';

export class CreateCategoryDto {
  /**
   * Vendeur cible — **réservé à l'ADMIN**, refusé (403) pour tout autre rôle.
   *
   * Un RESTAURATEUR ne transmet pas ce champ : son vendeur est déduit du compte
   * authentifié. C'est la même règle que `CreateProductDto.restaurantId`, et
   * elle vaut d'être unique : un `restaurantId` qui serait accepté puis
   * silencieusement remplacé selon l'appelant est précisément ce qui a rendu
   * les trois clients incohérents entre eux.
   */
  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  restaurantId?: string;

  @IsString()
  @IsNotEmpty({ message: 'Le nom de la catégorie est requis.' })
  @MaxLength(CATEGORY_NAME_MAX_LENGTH, {
    message: `Le nom d'une catégorie est limité à ${CATEGORY_NAME_MAX_LENGTH} caractères.`,
  })
  // Le `trim` est fait ici et non dans le service : « Boissons » et
  // « Boissons  » ne doivent jamais atteindre la base comme deux valeurs.
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  nom: string;

  @IsString()
  @IsOptional()
  @MaxLength(300)
  description?: string;

  @IsUrl()
  @IsOptional()
  imageUrl?: string;

  @IsInt()
  @IsOptional()
  @Min(0)
  displayOrder?: number;

  @IsBoolean()
  @IsOptional()
  isActive?: boolean;
}
