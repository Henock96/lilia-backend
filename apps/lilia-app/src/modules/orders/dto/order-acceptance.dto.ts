import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { VendorRejectionReason } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/** Bornes du temps de préparation annoncé au client à l'acceptation. */
export const PREP_MINUTES_MIN = 5;
export const PREP_MINUTES_MAX = 120;

/** `POST /orders/:id/accept` — Phase 3, F3-01. */
export class AcceptOrderDto {
  @ApiProperty({
    minimum: PREP_MINUTES_MIN,
    maximum: PREP_MINUTES_MAX,
    example: 20,
    description: 'Temps de préparation annoncé au client, en minutes.',
  })
  @Type(() => Number)
  @IsInt({
    message: 'Le temps de préparation est un nombre entier de minutes.',
  })
  @Min(PREP_MINUTES_MIN)
  @Max(PREP_MINUTES_MAX)
  prepMinutes: number;
}

/** `POST /orders/:id/reject` — Phase 3, F3-01. */
export class RejectOrderDto {
  @ApiProperty({ enum: VendorRejectionReason })
  @IsEnum(VendorRejectionReason, { message: 'Motif de refus inconnu.' })
  reason: VendorRejectionReason;

  /** Précision libre, jamais interprétée : bornée, et seulement affichée. */
  @ApiPropertyOptional({ maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  note?: string;

  /**
   * F3-10 — produits réellement en rupture (motif `OUT_OF_STOCK` seulement).
   * Ils ne sont pas remis en stock : ils passent à 0 (ou indisponibles s'ils
   * n'ont pas de compteur). Les autres lignes de la commande sont restituées
   * normalement. Absent (applications installées) : tout est restitué, comme
   * avant.
   */
  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  outOfStockProductIds?: string[];
}
