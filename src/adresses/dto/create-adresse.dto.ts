import { IsString, IsNotEmpty, IsOptional } from 'class-validator';

export class CreateAdresseDto {
  @IsString()
  @IsNotEmpty()
  rue: string;

  @IsString()
  @IsNotEmpty()
  ville: string;

  @IsString()
  @IsOptional()
  etat?: string;

  @IsString()
  @IsNotEmpty()
  country: string;

  @IsString()
  @IsOptional()
  quartierId?: string; // ID du quartier pour le calcul des frais de livraison
}
