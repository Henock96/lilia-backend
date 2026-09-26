import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { VendorOfferKind, VendorOfferStatus } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  IsDateString,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

import { PaginationQueryDto } from '../../../common/pagination/pagination-query.dto';

/** Plafond de saisie d'un montant d'offre — bien au-delà d'un panier réel. */
const MAX_OFFER_XAF = 10_000_000;

/**
 * Création d'une offre boutique (F3-11). L'offre démarre à sa création : une
 * seule offre peut être active à la fois, programmer la suivante n'a pas de
 * sens en V1. Les bornes métier (≤ 50 %, ≤ 30 jours, seuil ≥ 2 × remise) sont
 * vérifiées par le service avec des messages en français, et garanties par
 * les CHECK de la base.
 */
export class CreateVendorOfferDto {
  @ApiProperty({ enum: VendorOfferKind })
  @IsEnum(VendorOfferKind)
  kind: VendorOfferKind;

  @ApiProperty({
    description: 'Pourcentage (PERCENT) ou montant XAF (FIXED_THRESHOLD)',
  })
  @Type(() => Number)
  @IsInt({ message: 'La valeur de la remise doit être un nombre entier.' })
  @Min(1)
  @Max(MAX_OFFER_XAF)
  value: number;

  @ApiPropertyOptional({ description: 'Sous-total minimal, en XAF' })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(MAX_OFFER_XAF)
  @IsOptional()
  minSubTotalXaf?: number;

  @ApiPropertyOptional({
    description: 'Plafond de remise par commande (PERCENT), en XAF',
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_OFFER_XAF)
  @IsOptional()
  maxDiscountXaf?: number;

  @ApiProperty({ description: 'Fin de l’offre (ISO 8601), au plus 30 jours' })
  @IsDateString()
  endsAt: string;

  @ApiProperty({ description: 'Budget total financé par le vendeur, en XAF' })
  @Type(() => Number)
  @IsInt({ message: 'Le budget doit être un nombre entier.' })
  @Min(1)
  @Max(MAX_OFFER_XAF)
  budgetXaf: number;
}

export const VENDOR_OFFER_ACTIONS = ['PAUSE', 'RESUME', 'END'] as const;
export type VendorOfferAction = (typeof VENDOR_OFFER_ACTIONS)[number];

/**
 * Seuls gestes permis sur une offre existante. Les termes (montant, seuil,
 * budget) ne se modifient pas : on termine l'offre et on en crée une autre —
 * une commande passée doit pouvoir se relire contre l'offre qui l'a remisée.
 */
export class UpdateVendorOfferDto {
  @ApiProperty({ enum: VENDOR_OFFER_ACTIONS })
  @IsIn(VENDOR_OFFER_ACTIONS)
  action: VendorOfferAction;
}

export class StopVendorOfferDto {
  @ApiProperty({ description: 'Motif de l’arrêt, communiqué au vendeur' })
  @IsString()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @MinLength(5, { message: 'Précisez le motif (5 caractères au moins).' })
  @MaxLength(500)
  reason: string;
}

export class AdminVendorOffersQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: VendorOfferStatus })
  @IsEnum(VendorOfferStatus)
  @IsOptional()
  status?: VendorOfferStatus;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  restaurantId?: string;
}
