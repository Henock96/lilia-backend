import { DeliveryFailureReason, FailureLiability } from '@prisma/client';
import {
  IsBoolean,
  IsEnum,
  IsLatitude,
  IsLongitude,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

/** `POST /deliveries/:id/failure` — ce qui s'est passé, et où. */
export class DeclareDeliveryFailureDto {
  @IsEnum(DeliveryFailureReason)
  reason: DeliveryFailureReason;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;

  /** Position du déclarant : preuve pour « client injoignable » (R-05.4). */
  @IsOptional()
  @IsLatitude()
  latitude?: number;

  @IsOptional()
  @IsLongitude()
  longitude?: number;
}

/** `POST /admin/orders/:id/conclude-failure`. */
export class ConcludeFailureDto {
  @IsEnum(FailureLiability)
  liability: FailureLiability;

  /** Rend les montants sans rien écrire (écran d'arbitrage). */
  @IsOptional()
  @IsBoolean()
  dryRun?: boolean;
}
