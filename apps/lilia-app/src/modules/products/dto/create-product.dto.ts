import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { ProductType, StockMode } from '@prisma/client';

const TIME_HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Borne haute de sécurité sur les prix (fix H3 — audit du 28/08/2026).
 * Aucun plat de Brazzaville ne coûte 10 M XAF ; la borne existe pour qu'une
 * saisie aberrante ou un bug client soit rejeté au lieu d'être persisté.
 */
export const MAX_PRIX_XAF = 10_000_000;

/**
 * Borne haute sur les quantités de stock.
 *
 * Même esprit que `MAX_PRIX_XAF` : personne ne déclare un million de beignets.
 * La borne existe pour qu'une saisie aberrante — un champ texte mal converti,
 * un client bogué — soit rejetée en 400 explicite plutôt que persistée, et
 * pour que `stockRestant - quantite` reste très loin de tout débordement.
 */
export const MAX_STOCK_UNITS = 1_000_000;

class CreateProductVariantDto {
  @IsString()
  @IsOptional()
  label?: string; // e.g., "30cl", "Grand"

  // @Min(0) : sans lui, une variante à -50 000 faisait chuter le sous-total du
  // panier et rendait `serviceFee` négatif — le vendeur pouvait fabriquer une
  // commande gratuite (fix H3).
  @IsInt({
    message:
      'Un montant en francs CFA est un nombre entier — le XAF n’a pas de sous-unité.',
  })
  @IsNotEmpty()
  @Min(0, { message: 'Le prix ne peut pas être négatif.' })
  @Max(MAX_PRIX_XAF, { message: 'Prix hors limites.' })
  prix: number;
}

export class CreateProductDto {
  /**
   * Vendeur cible — **réservé à l'ADMIN**, refusé (403) pour tout autre rôle.
   *
   * Sert à amorcer le catalogue d'un vendeur pendant son onboarding, ou à le
   * dépanner. Omis, le produit est créé chez le vendeur de l'appelant, ce qui
   * reste le cas nominal. Le geste est tracé dans `AdminAuditLog`.
   */
  @IsString()
  @IsOptional()
  restaurantId?: string;

  @IsString()
  @IsNotEmpty()
  nom: string;

  @IsString()
  @IsOptional()
  description?: string;

  @IsUrl()
  @IsOptional()
  imageUrl?: string;

  @IsInt({
    message:
      'Un montant en francs CFA est un nombre entier — le XAF n’a pas de sous-unité.',
  })
  @IsNotEmpty()
  @Min(0, { message: 'Le prix ne peut pas être négatif.' })
  @Max(MAX_PRIX_XAF, { message: 'Prix hors limites.' })
  prixOriginal: number;

  @IsString()
  @IsOptional()
  categoryId?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateProductVariantDto)
  @IsOptional()
  variants?: CreateProductVariantDto[];

  // Multi-vendeurs (LIL-114)
  // Défaut FOOD pour préserver le comportement historique des restaurants.
  // ALCOHOL est dans l'enum mais rejeté au lancement (cf. ProductValidator).
  @IsEnum(ProductType)
  @IsOptional()
  productType?: ProductType;

  // DAILY = reset chaque nuit (plats du jour), PERMANENT = stock réel.
  @IsEnum(StockMode)
  @IsOptional()
  stockMode?: StockMode;

  // `null` / absent = stock illimité. `0` = épuisé (deux états distincts, cf.
  // `Product.stockRestant` au schéma).
  @IsInt({ message: 'Le stock est un nombre entier d’unités.' })
  @IsOptional()
  @Min(0, { message: 'Le stock ne peut pas être négatif.' })
  @Max(MAX_STOCK_UNITS, { message: 'Stock hors limites.' })
  stockQuotidien?: number | null;

  // Fait maison / pâtisserie
  @IsString()
  @IsOptional()
  @MaxLength(1000)
  ingredients?: string;

  @IsInt()
  @IsOptional()
  @Min(1)
  shelfLifeDays?: number;

  @IsBoolean()
  @IsOptional()
  madeToOrder?: boolean;

  // Disponibilité horaire (BAKERY surtout — ex: viennoiseries du matin)
  @IsString()
  @IsOptional()
  @Matches(TIME_HHMM, { message: 'availableFrom doit être au format HH:mm' })
  availableFrom?: string;

  @IsString()
  @IsOptional()
  @Matches(TIME_HHMM, { message: 'availableUntil doit être au format HH:mm' })
  availableUntil?: string;
}
