import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { PaginationQueryDto } from '../../../common/pagination/pagination-query.dto';

/**
 * Pagination du catalogue public des vendeurs (fix P0).
 *
 * Même contrat que `PaginationQueryDto`, avec un défaut de 50 au lieu de 20 :
 * la page d'accueil des apps liste les vendeurs d'un coup, et retomber à 20
 * aurait tronqué l'affichage sans que personne ne le demande. La borne haute
 * (100) reste celle de la pagination partagée.
 */
export class RestaurantListQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 50 })
  @Type(() => Number)
  @IsInt({ message: 'limit doit être un entier' })
  @Min(1, { message: 'limit doit être supérieur ou égal à 1' })
  @Max(100, { message: 'limit ne peut pas dépasser 100' })
  @IsOptional()
  limit: number = 50;
}
