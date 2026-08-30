import { Type } from 'class-transformer';
import {
  IsLatitude,
  IsLongitude,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
  IsNotEmpty,
} from 'class-validator';

/**
 * Payload de l'event WS `driver:position`.
 *
 * Le `useGlobalPipes` de `main.ts` ne couvre QUE le transport HTTP : sans ce
 * DTO, `lat`/`lng` arrivaient bruts dans `GEOADD` Redis et dans le calcul
 * Haversine de l'ETA. Un `NaN` ou une chaîne empoisonnait l'ETA affichée au
 * client (l'appelant est déjà authentifié et assigné, donc l'impact s'arrête là).
 */
export class DriverPositionDto {
  @IsString()
  @IsNotEmpty()
  orderId: string;

  @Type(() => Number)
  @IsLatitude()
  lat: number;

  @Type(() => Number)
  @IsLongitude()
  lng: number;

  // Précision GPS en mètres. Une valeur absurde (négative ou de l'ordre du
  // kilomètre) signale un fix inutilisable — on la refuse plutôt que de la
  // propager.
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(10000)
  accuracy?: number;
}

/** Payload de l'event WS `order:watch`. */
export class WatchOrderDto {
  @IsString()
  @IsNotEmpty()
  orderId: string;
}
