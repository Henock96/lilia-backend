import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { MAX_STOCK_UNITS } from './create-product.dto';

/**
 * Corps de `PATCH /products/:id/stock` — réapprovisionnement explicite.
 *
 * La route lisait `@Body('stockQuotidien')` **brut**, sans DTO : aucune
 * validation à l'exécution. `"abc"` arrivait jusqu'à Prisma (500), `-5`
 * s'écrivait tel quel, et un entier hors bornes aussi. C'est le même défaut que
 * `POST /payments` (fix H1) et le webhook MTN (fix M13) : une route typée
 * seulement par TypeScript n'est pas une route validée.
 *
 * `null` est une valeur **significative** ici : elle repasse le produit en
 * stock illimité. `@IsOptional()` laisse passer `null` comme `undefined` ; la
 * distinction entre les deux est faite par le service, qui traite `undefined`
 * comme « champ absent » et `null` comme « illimité ».
 */
export class UpdateProductStockDto {
  @IsInt({ message: 'Le stock est un nombre entier d’unités.' })
  @IsOptional()
  @Min(0, { message: 'Le stock ne peut pas être négatif.' })
  @Max(MAX_STOCK_UNITS, { message: 'Stock hors limites.' })
  stockQuotidien?: number | null;
}
