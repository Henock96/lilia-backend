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

/**
 * Corps de `PATCH /categories/:id`.
 *
 * ⚠️ **Pas de `restaurantId`.** Déplacer une catégorie d'un vendeur à un autre
 * n'a aucun sens métier — ses produits, eux, ne bougeraient pas — et la clé
 * étrangère composite le refuserait de toute façon. Le champ est donc absent du
 * contrat plutôt qu'accepté puis ignoré ; le `ValidationPipe` en `whitelist`
 * le retire s'il est envoyé.
 */
export class UpdateCategoryDto {
  @IsString()
  @IsOptional()
  @IsNotEmpty({ message: 'Le nom de la catégorie ne peut pas être vide.' })
  @MaxLength(CATEGORY_NAME_MAX_LENGTH, {
    message: `Le nom d'une catégorie est limité à ${CATEGORY_NAME_MAX_LENGTH} caractères.`,
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  nom?: string;

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
