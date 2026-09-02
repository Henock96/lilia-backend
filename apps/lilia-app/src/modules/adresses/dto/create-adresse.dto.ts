import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsLatitude,
  IsLongitude,
  MaxLength,
} from 'class-validator';
import { Type } from 'class-transformer';

export class CreateAdresseDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  rue: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  ville: string;

  @IsString()
  @IsOptional()
  @MaxLength(100)
  etat?: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  country: string;

  @IsString()
  @IsOptional()
  quartierId?: string; // ID du quartier pour le calcul des frais de livraison

  // ── Position de l'adresse ─────────────────────────────────────────────
  // `@IsLatitude` / `@IsLongitude` rejettent NaN et Infinity, que `@IsNumber`
  // laisse passer. Les bornes Congo, l'inversion lat/lng et le point (0, 0)
  // sont vérifiés dans le service, qui peut rendre un message expliquant quoi
  // corriger — un décorateur ne sait dire que « invalide ».
  //
  // Optionnelles : une adresse sans position reste créable (le repli sur le
  // centroïde du quartier la rend livrable), mais elle sera marquée
  // `UNKNOWN` et affichée comme telle au livreur.
  @IsOptional()
  @IsLatitude({ message: 'Latitude invalide.' })
  @Type(() => Number)
  latitude?: number;

  @IsOptional()
  @IsLongitude({ message: 'Longitude invalide.' })
  @Type(() => Number)
  longitude?: number;

  /** Repères pour le livreur : « portail bleu face à la pharmacie ». */
  @IsString()
  @IsOptional()
  @MaxLength(300, {
    message: 'Les repères sont limités à 300 caractères',
  })
  landmark?: string;

  /** Nom donné par le client : « Maison », « Bureau ». */
  @IsString()
  @IsOptional()
  @MaxLength(50)
  label?: string;
}
