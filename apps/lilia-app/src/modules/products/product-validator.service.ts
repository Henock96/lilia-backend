/* eslint-disable prettier/prettier */
import { BadRequestException, Injectable } from '@nestjs/common';
import { ProductType, VendorType } from '@prisma/client';

/**
 * Matrice de compatibilité vendorType ↔ productType (LIL-114).
 *
 * Un BAKERY ne peut pas vendre du GROCERY ; un BEVERAGE_SHOP ne vend pas
 * de FOOD chaud ; etc. La validation empêche les vendeurs de polluer leur
 * catalogue avec des produits hors scope (et casser les filtres marketplace).
 *
 * ALCOHOL est listé pour cohérence avec l'enum DB mais TOUJOURS rejeté
 * au lancement (pivot, cf. project-lilia-no-alcohol-initial). Quand on
 * réintroduira l'alcool, retirer le check `rejectAlcohol`.
 */
const VENDOR_PRODUCT_MATRIX: Record<VendorType, ProductType[]> = {
  RESTAURANT: [ProductType.FOOD, ProductType.BEVERAGE],
  HOME_COOK: [ProductType.FOOD, ProductType.PASTRY],
  BAKERY: [ProductType.PASTRY, ProductType.FOOD],
  BEVERAGE_SHOP: [ProductType.BEVERAGE],
  GROCERY: [ProductType.GROCERY, ProductType.BEVERAGE], // Réservé futur
};

@Injectable()
export class ProductValidatorService {
  /**
   * Vérifie qu'un produit du type donné peut être vendu par ce vendeur.
   * Lève BadRequestException si :
   * - le productType est ALCOHOL (pivot — pas de vente d'alcool au lancement)
   * - le productType n'est pas autorisé pour ce vendorType
   */
  assertProductTypeAllowed(vendorType: VendorType, productType: ProductType) {
    if (productType === ProductType.ALCOHOL) {
      throw new BadRequestException(
        'La vente d\'alcool n\'est pas activée sur Lilia Food.',
      );
    }

    const allowed = VENDOR_PRODUCT_MATRIX[vendorType];
    if (!allowed.includes(productType)) {
      throw new BadRequestException(
        `Un vendeur ${vendorType} ne peut pas vendre des produits ${productType}. ` +
          `Types autorisés : ${allowed.join(', ')}.`,
      );
    }
  }

  /**
   * Valide les fenêtres horaires availableFrom/availableUntil :
   * les deux doivent être fournis ensemble et form < until.
   * Format déjà vérifié au niveau DTO (HH:mm).
   */
  assertAvailabilityWindow(from?: string, until?: string) {
    if (from === undefined && until === undefined) return;
    if (from === undefined || until === undefined) {
      throw new BadRequestException(
        'availableFrom et availableUntil doivent être fournis ensemble.',
      );
    }
    if (from >= until) {
      throw new BadRequestException(
        'availableFrom doit être strictement avant availableUntil.',
      );
    }
  }
}
