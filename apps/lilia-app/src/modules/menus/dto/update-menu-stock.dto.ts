import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { MAX_STOCK_UNITS } from '../../products/dto/create-product.dto';

/**
 * Corps de `PATCH /menus/:id/stock`.
 *
 * La route lisait `@Body('stockQuotidien')` **brut** : aucune validation à
 * l'exécution — `"abc"` arrivait jusqu'à Prisma (500) et `-5` s'écrivait
 * (le CHECK le refusait, en 500). Même défaut que celui corrigé sur
 * `PATCH /products/:id/stock`. `null` = menu illimité.
 */
export class UpdateMenuStockDto {
  @IsInt({ message: 'Le stock est un nombre entier de menus.' })
  @IsOptional()
  @Min(0, { message: 'Le stock ne peut pas être négatif.' })
  @Max(MAX_STOCK_UNITS, { message: 'Stock hors limites.' })
  stockQuotidien?: number | null;
}
