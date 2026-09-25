import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

import {
  MODIFIER_LIMITS,
  OPTION_ID_PATTERN,
} from '../../modifiers/modifier-selection';

/**
 * Plafond de quantité par ligne de panier.
 *
 * `@Min(1)` seul laissait passer `quantite: 2000000000` sur un produit à stock
 * illimité (`stockRestant = null`, le cas par défaut) : la validation de stock
 * ne s'applique qu'aux produits à stock limité, et le calculateur multiplie
 * sans garde — on créait une commande à plusieurs milliards de FCFA qui partait
 * en notification au restaurateur.
 */
export const MAX_ITEM_QUANTITY = 50;

/**
 * F3-09 — une option choisie. **Ni prix, ni nom, ni groupe** : le serveur les
 * relit au catalogue. Un client ne peut rien affirmer d'autre que « je veux
 * cette option, tant de fois ».
 */
export class CartOptionDto {
  @IsString()
  @Matches(OPTION_ID_PATTERN, { message: 'Identifiant d’option invalide.' })
  optionId: string;

  @IsInt()
  @Min(1)
  @Max(MODIFIER_LIMITS.MAX_OPTION_QUANTITY, {
    message: `Quantité d'option maximale : ${MODIFIER_LIMITS.MAX_OPTION_QUANTITY}`,
  })
  quantity: number;
}

export class AddToCartDto {
  @IsString()
  @IsNotEmpty()
  variantId: string;

  @IsInt()
  @Min(1)
  @Max(MAX_ITEM_QUANTITY, {
    message: `Quantité maximale : ${MAX_ITEM_QUANTITY} par article`,
  })
  quantite: number;

  /**
   * F3-09 — options choisies. **Facultatif** : les applications installées ne
   * l'envoient pas. Absent sur un produit dont un groupe est obligatoire, le
   * serveur répond `400 MODIFIER_REQUIRED` — il ne choisit jamais à la place du
   * client. Une même option citée deux fois est refusée (`DUPLICATE_OPTION`).
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MODIFIER_LIMITS.MAX_DISTINCT_OPTIONS_PER_LINE, {
    message: `${MODIFIER_LIMITS.MAX_DISTINCT_OPTIONS_PER_LINE} options au maximum par article.`,
  })
  @ValidateNested({ each: true })
  @Type(() => CartOptionDto)
  options?: CartOptionDto[];
}
