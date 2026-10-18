import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsIn,
  IsNotEmpty,
  IsString,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';

import {
  PICKUP_ARBITRATION_REASONS,
  PickupArbitrationReason,
} from '../pickup-arbitration';

/**
 * `POST /admin/orders/:id/pickup/arbitrate` — 1B (ADM-03, D-1).
 *
 * Motif obligatoire en liste fermée ; la note devient obligatoire pour
 * `OTHER`, sans quoi l'arbitrage ne dirait rien de ce qui l'a justifié.
 */
export class ArbitratePickupDto {
  @ApiProperty({ enum: PICKUP_ARBITRATION_REASONS })
  @IsIn(PICKUP_ARBITRATION_REASONS, { message: 'Motif d’arbitrage inconnu.' })
  reason!: PickupArbitrationReason;

  @ApiPropertyOptional({ maxLength: 300 })
  // Pas de `@IsOptional()` : il sauterait toute validation d'une note absente,
  // donc `OTHER` sans note passerait. `@ValidateIf` porte seul le facultatif.
  // Nettoyée AVANT validation : cinq espaces passeraient `@MinLength(5)`, puis
  // se réduiraient à rien — un `OTHER` sans explication.
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @ValidateIf(
    (dto: ArbitratePickupDto) =>
      dto.reason === 'OTHER' || dto.note !== undefined,
  )
  @IsString()
  @IsNotEmpty({ message: 'Précisez le motif de l’arbitrage.' })
  @MinLength(5, {
    message: 'Précisez le motif de l’arbitrage (5 caractères au moins).',
  })
  @MaxLength(300)
  note?: string;
}
