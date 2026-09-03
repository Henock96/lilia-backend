// promo/dto/create-promo-code.dto.ts
import {
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  Validate,
} from 'class-validator';

import { PromoDiscountValueConstraint } from './discount-value.validator';

export enum DiscountType {
  FIXED = 'FIXED',
  PERCENT = 'PERCENT',
  FREE_DELIVERY = 'FREE_DELIVERY',
}

/**
 * Borne haute des montants d'une campagne promo, en XAF.
 *
 * Même intention que `MAX_PRIX_XAF` côté produit (fix H3) : une saisie
 * aberrante est rejetée à l'entrée plutôt que persistée puis déduite d'une
 * commande réelle.
 */
export const MAX_PROMO_AMOUNT_XAF = 10_000_000;

export class CreatePromoCodeDto {
  @IsString()
  @MinLength(3)
  @MaxLength(20)
  code: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsEnum(DiscountType)
  discountType: DiscountType;

  /**
   * 500 si `FIXED` (un montant XAF), 10 ou 7,5 si `PERCENT` (une proportion).
   *
   * C'est le seul champ monétaire resté décimal en base, parce qu'il n'est
   * monétaire qu'une fois sur deux. L'intégrité se joue donc **ici**, où le
   * discriminant est connu : en `FIXED`, un montant à virgule est refusé ; en
   * `PERCENT`, 7,5 % reste possible et borné à 100.
   */
  @IsNumber()
  @Min(0)
  @Max(MAX_PROMO_AMOUNT_XAF, { message: 'Valeur de remise hors limites.' })
  @Validate(PromoDiscountValueConstraint)
  discountValue: number;

  /** Plafond de remise, toujours un montant XAF — donc toujours entier. */
  @IsOptional()
  @IsInt({
    message:
      'Le plafond de remise est un nombre entier de francs CFA — le XAF n’a pas de sous-unité.',
  })
  @Min(0)
  @Max(MAX_PROMO_AMOUNT_XAF, { message: 'Plafond de remise hors limites.' })
  maxDiscount?: number;

  @IsOptional()
  @IsInt({
    message:
      'Le montant minimum de commande est un nombre entier de francs CFA — le XAF n’a pas de sous-unité.',
  })
  @Min(0)
  @Max(MAX_PROMO_AMOUNT_XAF, { message: 'Montant minimum hors limites.' })
  minOrderAmount?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  maxUsageTotal?: number; // null = illimité

  @IsOptional()
  @IsInt()
  @Min(1)
  maxUsagePerUser?: number;

  @IsOptional()
  @IsBoolean()
  firstOrderOnly?: boolean;

  @IsOptional()
  @IsString()
  restaurantId?: string; // null = toute la plateforme

  @IsOptional()
  @IsDateString()
  startsAt?: string;

  @IsOptional()
  @IsDateString()
  expiresAt?: string;
}
