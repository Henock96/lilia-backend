import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsOptional,
  IsString,
} from 'class-validator';

/**
 * Corps de `PATCH /categories/reorder`.
 *
 * On envoie la **liste ordonnée complète** plutôt qu'un couple
 * `(id, nouvelle position)` : deux réordonnancements concurrents partant d'un
 * ordre différent produiraient sinon un état qu'aucun des deux n'a voulu. Ici
 * le dernier écrivain pose un ordre cohérent de bout en bout.
 */
export class ReorderCategoriesDto {
  /** Vendeur cible — réservé à l'ADMIN, comme partout ailleurs. */
  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  restaurantId?: string;

  @ApiProperty({
    type: [String],
    description: "Ids des catégories, dans l'ordre voulu",
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @IsString({ each: true })
  categoryIds: string[];
}
