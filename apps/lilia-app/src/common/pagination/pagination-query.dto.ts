import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Pagination partagée par toutes les routes listantes.
 *
 * Remplace les `parseInt(limit, 10)` bruts des controllers, qui laissaient
 * passer deux classes de problèmes :
 *
 * - `?limit=500000` sur une route publique déclenchait un scan complet avec
 *   toutes les relations incluses — de quoi saturer PostgreSQL en quelques
 *   requêtes malgré le throttler ;
 * - `?limit=abc` donnait `NaN` et `?page=-1` un `skip` négatif, que Prisma
 *   rejette en 500 opaque.
 *
 * `ValidationPipe` global (`transform: true`) applique ce DTO sans autre
 * changement côté controller.
 */
export class PaginationQueryDto {
  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @Type(() => Number)
  @IsInt({ message: 'page doit être un entier' })
  @Min(1, { message: 'page doit être supérieur ou égal à 1' })
  @IsOptional()
  page: number = 1;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 20 })
  @Type(() => Number)
  @IsInt({ message: 'limit doit être un entier' })
  @Min(1, { message: 'limit doit être supérieur ou égal à 1' })
  @Max(100, { message: 'limit ne peut pas dépasser 100' })
  @IsOptional()
  limit: number = 20;
}

/**
 * Variante pour les routes où `limit` est facultatif et où le défaut appartient
 * au service (top produits, incidents…). Même borne haute, pas de valeur
 * imposée : `undefined` laisse le service décider.
 */
export class OptionalLimitQueryDto {
  @ApiPropertyOptional({ minimum: 1, maximum: 100 })
  @Type(() => Number)
  @IsInt({ message: 'limit doit être un entier' })
  @Min(1, { message: 'limit doit être supérieur ou égal à 1' })
  @Max(100, { message: 'limit ne peut pas dépasser 100' })
  @IsOptional()
  limit?: number;
}

/** Borne maximale appliquée aux listes, exposée pour la documentation. */
export const MAX_PAGE_SIZE = 100;
