import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateReviewDto {
  @ApiProperty({ description: 'Note de 1 à 5', minimum: 1, maximum: 5 })
  @IsInt()
  @Min(1)
  @Max(5)
  rating: number;

  @ApiPropertyOptional({ description: 'Commentaire optionnel' })
  @IsOptional()
  @IsString()
  comment?: string;

  @ApiProperty({ description: 'ID du restaurant' })
  @IsString()
  restaurantId: string;

  @ApiPropertyOptional({ description: 'ID de la commande liée (optionnel)' })
  @IsOptional()
  @IsString()
  orderId?: string;
}
