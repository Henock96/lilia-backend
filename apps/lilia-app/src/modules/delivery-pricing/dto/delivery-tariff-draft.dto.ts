import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

/** Plafond d'une course, en XAF — au-delà, c'est une faute de frappe. */
export const MAX_DELIVERY_FEE_XAF = 50_000;

export class DeliveryTariffBandDto {
  /** Borne haute de la tranche, incluse, en km routiers. */
  @IsNumber({ maxDecimalPlaces: 1 })
  @Min(0.1)
  @Max(100)
  maxKm: number;

  @IsInt()
  @Min(0)
  @Max(MAX_DELIVERY_FEE_XAF)
  feeXaf: number;
}

export class DeliveryTariffOverrideDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  originQuartierId: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  destQuartierId: string;

  @IsInt()
  @Min(0)
  @Max(MAX_DELIVERY_FEE_XAF)
  feeXaf: number;
}

/** Brouillon de grille (création comme remplacement complet). */
export class DeliveryTariffDraftDto {
  /** Distance à vol d'oiseau × ce coefficient = distance routière estimée. */
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(1)
  @Max(3)
  roadFactor: number;

  @IsArray()
  @ArrayMinSize(1, { message: 'Une grille compte au moins une tranche.' })
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => DeliveryTariffBandDto)
  bands: DeliveryTariffBandDto[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(1000)
  @ValidateNested({ each: true })
  @Type(() => DeliveryTariffOverrideDto)
  overrides?: DeliveryTariffOverrideDto[];

  @IsOptional()
  @IsString()
  @MaxLength(300)
  note?: string | null;
}
