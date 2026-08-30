import { Type } from 'class-transformer';
import { IsInt, IsOptional, Min } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

import { OptionalLimitQueryDto } from '../../../common/pagination/pagination-query.dto';

/** `GET /incidents` — pagination par offset, bornée comme partout ailleurs. */
export class IncidentListQueryDto extends OptionalLimitQueryDto {
  @ApiPropertyOptional({ minimum: 0 })
  @Type(() => Number)
  @IsInt({ message: 'offset doit être un entier' })
  @Min(0, { message: 'offset ne peut pas être négatif' })
  @IsOptional()
  offset?: number;
}
