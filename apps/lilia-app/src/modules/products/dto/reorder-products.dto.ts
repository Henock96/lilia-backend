import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsOptional,
  IsString,
} from 'class-validator';

/**
 * Corps de `PATCH /products/reorder`.
 *
 * Calqué sur `ReorderCategoriesDto`, et pour la même raison : on envoie la
 * **liste ordonnée complète** plutôt qu'un couple `(id, nouvelle position)`.
 * Deux réordonnancements concurrents partant d'un ordre différent produiraient
 * sinon un état qu'aucun des deux n'a voulu ; ici le dernier écrivain pose un
 * ordre cohérent de bout en bout.
 *
 * ℹ️ La liste soumise est celle d'un **groupe d'affichage** — en pratique une
 * section de la carte. Le serveur y écrit `0, 1, 2…`, si bien que deux sections
 * différentes peuvent porter les mêmes valeurs. Ce n'est pas une collision :
 * les clients groupent d'abord par catégorie, l'ordre ne départage qu'à
 * l'intérieur d'un groupe.
 */
export class ReorderProductsDto {
  /** Vendeur cible — réservé à l'ADMIN, comme partout ailleurs. */
  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  restaurantId?: string;

  @ApiProperty({
    type: [String],
    description: "Ids des produits, dans l'ordre voulu",
  })
  @IsArray()
  @ArrayMinSize(1)
  // Même plafond que la borne de pagination du catalogue : au-delà, on ne
  // réordonne plus une carte, on importe un fichier.
  @ArrayMaxSize(500)
  @IsString({ each: true })
  productIds: string[];
}
