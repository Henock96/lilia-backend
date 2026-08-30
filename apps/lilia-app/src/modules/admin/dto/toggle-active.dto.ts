import { IsBoolean } from 'class-validator';

/**
 * Corps de `PATCH /admin/restaurants/:id/toggle-active` (fix M20).
 *
 * La route lisait `@Body('isActive')` sans DTO : la valeur n'était ni validée
 * ni typée au runtime. `{"isActive": "false"}` (chaîne) était truthy et
 * ré-activait un vendeur qu'on voulait suspendre.
 */
export class ToggleActiveDto {
  @IsBoolean({ message: 'isActive doit être un booléen.' })
  isActive: boolean;
}
