import { IsLatitude, IsLongitude } from 'class-validator';
import { Type } from 'class-transformer';

/**
 * Centroïde d'un quartier, posé par un administrateur.
 *
 * Les deux champs sont **obligatoires** — contrairement aux coordonnées d'une
 * adresse client. Un quartier à moitié situé n'a aucun usage : le repli qui
 * s'appuie dessus a besoin des deux valeurs ou d'aucune.
 */
export class SetQuartierCentroidDto {
  @IsLatitude({ message: 'Latitude invalide.' })
  @Type(() => Number)
  latitude: number;

  @IsLongitude({ message: 'Longitude invalide.' })
  @Type(() => Number)
  longitude: number;
}
