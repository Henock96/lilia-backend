import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Seuil de l'alerte « commandes bloquées ».
 *
 * Borné des deux côtés : en dessous d'une minute la question n'a pas de sens,
 * au-delà de 24 h l'alerte remonterait l'historique entier et cesserait d'être
 * une alerte. Le service revalide ces bornes — un DTO protège la route, pas la
 * méthode.
 */
export class StuckOrdersQueryDto {
  @ApiPropertyOptional({ minimum: 1, maximum: 1440, default: 30 })
  @Type(() => Number)
  @IsInt({ message: 'minutes doit être un entier' })
  @Min(1, { message: 'minutes doit être supérieur ou égal à 1' })
  @Max(1440, { message: 'minutes ne peut pas dépasser 1440 (24 h)' })
  @IsOptional()
  minutes: number = 30;
}
