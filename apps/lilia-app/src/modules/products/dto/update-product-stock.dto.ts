import { IsIn, IsInt, IsOptional, Max, Min, ValidateIf } from 'class-validator';
import { MAX_STOCK_UNITS } from './create-product.dto';

/**
 * F3-10 — gestes de stock du vendeur.
 *
 * | `action`   | Politique       | Effet                                                    |
 * |------------|-----------------|----------------------------------------------------------|
 * | absent     | toutes          | ancien contrat : `stockQuotidien` = niveau déclaré (et restant) ; `null` = illimité |
 * | `RESTOCK`  | limitée         | « Réapprovisionner +N » : `stockRestant += N`, atomique  |
 * | `COUNT`    | `INVENTORY`     | « Faire l'inventaire = N » : N unités comptées sur place, moins celles déjà réservées par des commandes pas encore parties |
 *
 * `RESTOCK` et `COUNT` remplacent l'écrasement `restant = N`, qui perdait
 * en silence les ventes faites entre la lecture du vendeur et son écriture,
 * et comptait deux fois les unités réservées encore en rayon.
 *
 * `null` sur `stockQuotidien` (sans `action`) est une valeur **significative** :
 * elle repasse le produit en « Toujours disponible ».
 */
export class UpdateProductStockDto {
  @IsInt({ message: 'Le stock est un nombre entier d’unités.' })
  @IsOptional()
  @Min(0, { message: 'Le stock ne peut pas être négatif.' })
  @Max(MAX_STOCK_UNITS, { message: 'Stock hors limites.' })
  stockQuotidien?: number | null;

  @IsOptional()
  @IsIn(['RESTOCK', 'COUNT'], { message: 'Geste de stock inconnu.' })
  action?: 'RESTOCK' | 'COUNT';

  @ValidateIf((dto: UpdateProductStockDto) => dto.action !== undefined)
  @IsInt({ message: 'Le nombre d’unités est un entier.' })
  @Min(0, { message: 'Le nombre d’unités ne peut pas être négatif.' })
  @Max(MAX_STOCK_UNITS, { message: 'Stock hors limites.' })
  units?: number;
}
