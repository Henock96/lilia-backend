import { IsBoolean } from 'class-validator';

/**
 * Corps de `PATCH /products/:id/availability` (fix M2).
 *
 * Distinct du stock : « épuisé » (stock à 0) et « indisponible » (le vendeur ne
 * le propose pas aujourd'hui) sont deux informations différentes pour le
 * client, et le vendeur n'avait que la première à sa disposition.
 */
export class UpdateAvailabilityDto {
  @IsBoolean({ message: 'isAvailable doit être un booléen.' })
  isAvailable: boolean;
}
