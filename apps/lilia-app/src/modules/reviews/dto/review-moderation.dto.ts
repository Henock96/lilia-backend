import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { PaginationQueryDto } from '../../../common/pagination/pagination-query.dto';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

/** Lot B — avis reçus par le vendeur, une boutique ou toutes les siennes. */
export class VendorReviewsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: 'Limiter à une boutique' })
  @IsOptional()
  @IsString()
  restaurantId?: string;
}

/** Lot B (D4.c) — réponse publique du vendeur, une seule, modifiable. */
export class VendorReplyDto {
  @ApiProperty({ minLength: 2, maxLength: 1000 })
  @Transform(trim)
  @IsString()
  @MinLength(2, { message: 'La réponse est trop courte.' })
  @MaxLength(1000, { message: 'La réponse est limitée à 1000 caractères.' })
  text: string;
}

/** Lot B (D4.b) — masquage par l'admin : motif obligatoire, audité. */
export class HideReviewDto {
  @ApiProperty({ minLength: 5, maxLength: 300 })
  @Transform(trim)
  @IsString()
  @MinLength(5, { message: 'Le motif doit faire au moins 5 caractères.' })
  @MaxLength(300, { message: 'Le motif est limité à 300 caractères.' })
  reason: string;
}

export const REVIEW_VISIBILITY_FILTERS = ['visible', 'hidden', 'all'] as const;

/** Lot B — liste de modération (avis vendeurs ou notes livreurs). */
export class AdminReviewsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ minimum: 1, maximum: 5 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(5)
  rating?: number;

  @ApiPropertyOptional({ description: 'Avis d’une boutique' })
  @IsOptional()
  @IsString()
  restaurantId?: string;

  @ApiPropertyOptional({ description: 'Notes d’un livreur' })
  @IsOptional()
  @IsString()
  delivererId?: string;

  @ApiPropertyOptional({ enum: REVIEW_VISIBILITY_FILTERS, default: 'all' })
  @IsOptional()
  @IsIn(REVIEW_VISIBILITY_FILTERS)
  visibility?: (typeof REVIEW_VISIBILITY_FILTERS)[number];
}
