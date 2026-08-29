import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Fenêtre du graphique de chiffre d'affaires (fix L14 / P2).
 *
 * `@Query('days') days = '30'` puis `parseInt` brut : `?days=999999` déclenchait
 * une agrégation sur toute la table, et `?days=abc` donnait `NaN`. 365 jours
 * couvrent tout l'usage réel d'un tableau de bord vendeur.
 */
export class RevenueChartQueryDto {
  @ApiPropertyOptional({ minimum: 1, maximum: 365, default: 30 })
  @Type(() => Number)
  @IsInt({ message: 'days doit être un entier' })
  @Min(1, { message: 'days doit être supérieur ou égal à 1' })
  @Max(365, { message: 'days ne peut pas dépasser 365' })
  @IsOptional()
  days: number = 30;
}
