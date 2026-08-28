import { IsInt, IsNotEmpty, IsString, Max, Min } from 'class-validator';

/**
 * Plafond de quantité par ligne de panier.
 *
 * `@Min(1)` seul laissait passer `quantite: 2000000000` sur un produit à stock
 * illimité (`stockRestant = null`, le cas par défaut) : la validation de stock
 * ne s'applique qu'aux produits à stock limité, et le calculateur multiplie
 * sans garde — on créait une commande à plusieurs milliards de FCFA qui partait
 * en notification au restaurateur.
 */
export const MAX_ITEM_QUANTITY = 50;

export class AddToCartDto {
  @IsString()
  @IsNotEmpty()
  variantId: string;

  @IsInt()
  @Min(1)
  @Max(MAX_ITEM_QUANTITY, {
    message: `Quantité maximale : ${MAX_ITEM_QUANTITY} par article`,
  })
  quantite: number;
}
