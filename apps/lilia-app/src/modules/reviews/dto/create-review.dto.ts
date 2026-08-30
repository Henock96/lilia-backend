import {
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateReviewDto {
  @ApiProperty({ description: 'Note de 1 à 5', minimum: 1, maximum: 5 })
  @IsInt()
  @Min(1)
  @Max(5)
  rating: number;

  // Affiché dans les 3 apps + le web : un commentaire non borné casse
  // l'affichage partout à la fois.
  @ApiPropertyOptional({
    description: 'Commentaire optionnel',
    maxLength: 1000,
  })
  @IsOptional()
  @IsString()
  @MaxLength(1000, {
    message: 'Le commentaire est limité à 1000 caractères',
  })
  comment?: string;

  @ApiProperty({ description: 'ID du restaurant' })
  @IsString()
  restaurantId: string;

  @ApiPropertyOptional({ description: 'ID de la commande liée (optionnel)' })
  @IsOptional()
  @IsString()
  orderId?: string;
}
