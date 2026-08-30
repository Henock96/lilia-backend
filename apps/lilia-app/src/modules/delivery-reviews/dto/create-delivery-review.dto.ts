/* eslint-disable prettier/prettier */
import { IsInt, IsNotEmpty, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Note du livreur par le client (1 à 5 étoiles).
 *
 * Le `delivererId` n'est PAS dans le DTO : il est dérivé de la livraison côté
 * serveur. Le laisser au client permettrait de noter quelqu'un d'autre que le
 * livreur qui a réellement fait la course.
 */
export class CreateDeliveryReviewDto {
  @ApiProperty({ description: 'ID de la livraison à noter' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  deliveryId: string;

  @ApiProperty({ description: 'Note de 1 à 5', minimum: 1, maximum: 5 })
  @IsInt({ message: 'La note doit être un entier entre 1 et 5.' })
  @Min(1, { message: 'La note minimale est 1.' })
  @Max(5, { message: 'La note maximale est 5.' })
  rating: number;

  // Même borne que les avis vendeur : le commentaire est réaffiché dans l'app
  // livreur et dans l'admin.
  @ApiPropertyOptional({ description: 'Commentaire optionnel', maxLength: 1000 })
  @IsOptional()
  @IsString()
  @MaxLength(1000, { message: 'Le commentaire est limité à 1000 caractères' })
  comment?: string;
}
