import {
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

export class ValidatePromoDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(32)
  code: string;

  /**
   * ⚠️ Champs IGNORÉS depuis le fix L6 (audit du 28/08/2026).
   *
   * Le service calcule le sous-total et les frais depuis le **panier serveur**
   * et le vendeur qui lui est rattaché : accepter ces valeurs du client faisait
   * de l'endpoint un oracle de calcul de réduction et permettait de contourner
   * `minOrderAmount` en aperçu. Ils restent déclarés — donc tolérés par
   * `whitelist: true` — pour que les clients déjà déployés continuent de
   * fonctionner sans erreur de validation. À retirer quand les 3 apps auront
   * cessé de les envoyer.
   */
  @IsString()
  @IsOptional()
  restaurantId?: string;

  @IsNumber()
  @Min(0)
  @IsOptional()
  subTotal?: number;

  @IsNumber()
  @Min(0)
  @IsOptional()
  deliveryFee?: number;
}
