import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';

import {
  DELIVERY_ARBITRATION_REASONS,
  DeliveryArbitrationReason,
} from '../delivery-arbitration';

/**
 * `POST /admin/orders/:id/delivery/arbitrate` — arbitrage de livraison (D1).
 *
 * Motif en liste fermée, note obligatoire pour `OTHER` (mêmes règles que
 * l'arbitrage de retrait). Avoir facultatif, mêmes bornes que celui d'une
 * réclamation ; le plafond « total de la commande » est vérifié par le
 * service, qui seul connaît la commande.
 */
export class ArbitrateDeliveryDto {
  @ApiProperty({ enum: DELIVERY_ARBITRATION_REASONS })
  @IsIn(DELIVERY_ARBITRATION_REASONS, { message: 'Motif d’arbitrage inconnu.' })
  reason!: DeliveryArbitrationReason;

  @ApiPropertyOptional({ maxLength: 300 })
  // Même construction que `ArbitratePickupDto` : `@ValidateIf` porte seul le
  // facultatif, et la note est nettoyée avant validation.
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @ValidateIf(
    (dto: ArbitrateDeliveryDto) =>
      dto.reason === 'OTHER' || dto.note !== undefined,
  )
  @IsString()
  @IsNotEmpty({ message: 'Précisez le motif de l’arbitrage.' })
  @MinLength(5, {
    message: 'Précisez le motif de l’arbitrage (5 caractères au moins).',
  })
  @MaxLength(300)
  note?: string;

  @ApiPropertyOptional({ minimum: 100, maximum: 100_000 })
  @IsOptional()
  @IsInt()
  @Min(100)
  @Max(100_000)
  voucherAmountXaf?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 90 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(90)
  voucherExpiresInDays?: number;
}
