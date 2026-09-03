import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsInt, Max, Min } from 'class-validator';

/**
 * Position d'un vendeur dans les listes publiques.
 *
 * Borné à [1, 9999] : `0` est écarté volontairement pour que « premier » et
 * « pas encore classé » (le défaut, 1000) restent deux valeurs distinctes, et
 * le plafond évite qu'une faute de frappe range un vendeur derrière un nombre
 * que plus personne ne saura corriger à la main.
 */
export class UpdateDisplayOrderDto {
  @ApiProperty({ minimum: 1, maximum: 9999, example: 1 })
  @IsInt({ message: "L'ordre d'affichage doit être un entier." })
  @Min(1, { message: "L'ordre d'affichage commence à 1." })
  @Max(9999)
  displayOrder: number;
}

export class UpdateFeaturedDto {
  @ApiProperty({ example: true })
  @IsBoolean()
  isFeatured: boolean;
}
