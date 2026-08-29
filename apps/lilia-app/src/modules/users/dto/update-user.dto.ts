/* eslint-disable prettier/prettier */
import { IsOptional, IsString, IsUrl, Matches, MaxLength } from 'class-validator';

/**
 * Bornes ajoutées (fix M20 — audit du 28/08/2026) : `nom` et `phone` étaient
 * de simples `@IsString()`. Un client pouvait donc pousser jusqu'à 100 ko de
 * texte dans son nom, texte ensuite réaffiché dans le back-office vendeur et
 * dans l'admin.
 */
export class UpdateUserDto {
  @IsOptional()
  @IsString()
  @MaxLength(80, { message: 'Le nom ne peut pas dépasser 80 caractères.' })
  nom?: string;

  @IsOptional()
  @IsString()
  @Matches(/^(\+?242)?0?[456]\d{7}$/, {
    message: 'Numéro de téléphone congolais invalide (ex : 06 123 45 67)',
  })
  phone?: string;

  @IsOptional()
  @IsUrl({}, { message: 'L\'URL de l\'image doit être une URL valide.' })
  @MaxLength(500)
  imageUrl?: string;
}
