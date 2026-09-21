import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsLatitude,
  IsLongitude,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

/**
 * Corps des deux routes HTTP de tracking.
 *
 * ⚠️ Ces routes déclaraient leur corps par un **type TypeScript inline**, qui
 * n'existe pas au runtime : le `ValidationPipe` global n'avait donc rien à
 * valider. `lat`, `lng` et la taille du lot arrivaient bruts dans `GEOADD`
 * Redis, dans le calcul Haversine de l'ETA et dans `DeliveryLocation`.
 *
 * Même défaut que le « fix H1 » de `payment.service.ts`, et même correction :
 * une **classe**, pas une interface.
 *
 * Les bornes sont volontairement celles de `DriverPositionDto` (voie
 * WebSocket) : les deux transports décrivent le même geste, et deux jeux de
 * bornes différents finiraient par diverger. Le contrôle « coordonnées au
 * Congo » reste ailleurs (`common/geo/congo-geo.ts`) — ici on refuse ce qui
 * n'est pas une coordonnée, pas ce qui n'est pas à Brazzaville : un livreur au
 * bord de la zone ne doit pas voir sa position rejetée.
 */
export class PositionDto {
  @IsString()
  @IsNotEmpty()
  orderId: string;

  @Type(() => Number)
  @IsLatitude()
  lat: number;

  @Type(() => Number)
  @IsLongitude()
  lng: number;

  /**
   * Précision GPS en mètres. Une valeur absurde (négative, ou de l'ordre de la
   * dizaine de kilomètres) signale un fix inutilisable — on la refuse plutôt
   * que de la propager jusqu'à l'écran du client.
   */
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(10000)
  accuracy?: number;
}

/** Un point accumulé hors ligne. */
export class BufferedPositionDto {
  @Type(() => Number)
  @IsLatitude()
  lat: number;

  @Type(() => Number)
  @IsLongitude()
  lng: number;

  /** Horodatage client (ms epoch). Conservé pour l'ordre du lot. */
  @Type(() => Number)
  @IsInt()
  @Min(0)
  timestamp: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(10000)
  accuracy?: number;
}

/**
 * Synchronisation d'un lot accumulé hors ligne.
 *
 * ⚠️ `@ValidateNested({ each: true })` est indispensable : sans lui,
 * class-validator vérifie que `positions` est un tableau et s'arrête là. Or le
 * contrôleur n'utilise que le **dernier** point — une validation superficielle
 * laisserait donc passer précisément la valeur qui atteint Redis et la base.
 */
export class BatchPositionsDto {
  @IsString()
  @IsNotEmpty()
  orderId: string;

  @IsArray()
  // Un lot vide n'a rien à synchroniser : la garde existait déjà dans le
  // contrôleur, elle est désormais portée par le contrat.
  @ArrayMinSize(1)
  // Le livreur accumule pendant une coupure, pas pendant une semaine. 500
  // points à une position toutes les 5 s couvrent plus de 40 minutes hors
  // ligne ; au-delà, c'est un corps de requête qu'on ne veut pas parser.
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => BufferedPositionDto)
  positions: BufferedPositionDto[];
}
