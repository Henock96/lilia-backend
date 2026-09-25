import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

import { MAX_PRIX_XAF } from '../../products/dto/create-product.dto';
import { MODIFIER_LIMITS, OPTION_ID_PATTERN } from '../modifier-selection';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

/**
 * `restaurantId` n'est accepté que d'un ADMIN agissant pour un vendeur
 * (`RestaurantAccessService.resolveTargetRestaurant`). Un RESTAURATEUR qui le
 * renseigne — même avec son propre identifiant — reçoit 403 : il reste chez
 * lui sans avoir à dire où il est.
 */
export class ModifierTargetDto {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  restaurantId?: string;
}

/** Une option dans le formulaire d'un groupe. `id` absent = création. */
export class ModifierOptionInputDto {
  @IsOptional()
  @IsString()
  @Matches(OPTION_ID_PATTERN)
  id?: string;

  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  name: string;

  /** Supplément en FCFA — jamais négatif (R-09.6). */
  @IsInt()
  @Min(0)
  @Max(MAX_PRIX_XAF)
  priceDeltaXaf: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MODIFIER_LIMITS.MAX_OPTION_QUANTITY)
  maxQuantity?: number;

  @IsOptional()
  @IsBoolean()
  isAvailable?: boolean;
}

export class CreateModifierGroupDto extends ModifierTargetDto {
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  name: string;

  /** 0 = facultatif ; ≥ 1 = obligatoire. En options DISTINCTES. */
  @IsInt()
  @Min(0)
  @Max(MODIFIER_LIMITS.MAX_DISTINCT_OPTIONS_PER_LINE)
  minSelect: number;

  /** 1 = choix unique (radio). En options DISTINCTES. */
  @IsInt()
  @Min(1)
  @Max(MODIFIER_LIMITS.MAX_DISTINCT_OPTIONS_PER_LINE)
  maxSelect: number;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MODIFIER_LIMITS.MAX_OPTIONS_PER_GROUP)
  @ValidateNested({ each: true })
  @Type(() => ModifierOptionInputDto)
  options: ModifierOptionInputDto[];
}

/**
 * Modification d'un groupe. `options`, s'il est fourni, est la liste
 * **complète** voulue (même convention que les variantes d'un produit) :
 * `id` connu = mise à jour, sans `id` = création, absente = retirée.
 */
export class UpdateModifierGroupDto extends ModifierTargetDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  name?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MODIFIER_LIMITS.MAX_DISTINCT_OPTIONS_PER_LINE)
  minSelect?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MODIFIER_LIMITS.MAX_DISTINCT_OPTIONS_PER_LINE)
  maxSelect?: number;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MODIFIER_LIMITS.MAX_OPTIONS_PER_GROUP)
  @ValidateNested({ each: true })
  @Type(() => ModifierOptionInputDto)
  options?: ModifierOptionInputDto[];
}

export class SetModifierOptionAvailabilityDto extends ModifierTargetDto {
  @IsBoolean()
  isAvailable: boolean;
}

/** Groupes attachés à un produit, dans l'ordre voulu. Remplacement complet. */
export class AttachModifierGroupsDto extends ModifierTargetDto {
  @IsArray()
  @ArrayMaxSize(MODIFIER_LIMITS.MAX_GROUPS_PER_PRODUCT)
  @ArrayUnique()
  @IsString({ each: true })
  groupIds: string[];
}

/** Ordre de la bibliothèque. */
export class ReorderModifierGroupsDto extends ModifierTargetDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MODIFIER_LIMITS.MAX_GROUPS_PER_VENDOR)
  @ArrayUnique()
  @IsString({ each: true })
  groupIds: string[];
}
