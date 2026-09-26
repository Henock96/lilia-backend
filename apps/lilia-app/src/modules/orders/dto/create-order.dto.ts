import {
  IsString,
  IsNotEmpty,
  IsEnum,
  IsOptional,
  IsBoolean,
  IsNumber,
  IsDateString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { PaymentMethod } from '@prisma/client';
import { Transform } from 'class-transformer';
import { OmitType } from '@nestjs/swagger';

export class CreateOrderDto {
  @IsString()
  @IsOptional()
  adresseId?: string;

  @IsEnum(PaymentMethod)
  @IsNotEmpty()
  paymentMethod: PaymentMethod;

  // Ce texte est réinjecté tel quel dans la notification FCM du restaurateur
  // et dans l'écran admin : sans borne, 100 ko de texte (limite du body parser)
  // passaient jusqu'à la base et jusqu'aux écrans.
  @IsString()
  @MaxLength(500, {
    message: 'Les instructions sont limitées à 500 caractères',
  })
  @IsOptional()
  notes?: string;

  @IsBoolean()
  @IsOptional()
  @Transform(({ value }) => value ?? true)
  isDelivery?: boolean = true;

  // Numéros congolais : 06/05/04 + 7 chiffres, avec ou sans indicatif +242.
  // Les espaces et séparateurs sont retirés avant validation — les claviers
  // mobiles en insèrent, et un rejet sur un espace serait incompréhensible.
  @IsString()
  @Transform(({ value }) =>
    typeof value === 'string' ? value.replace(/[\s.\-()]/g, '') : value,
  )
  @Matches(/^(\+?242)?0?[456]\d{7}$/, {
    message: 'Numéro de téléphone congolais invalide (ex : 06 123 45 67)',
  })
  @IsOptional()
  contactPhone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(32, { message: 'Code promo invalide' })
  promoCode?: string;

  @IsBoolean()
  @IsOptional()
  useLoyaltyPoints?: boolean;

  // Bornes géographiques : une latitude hors [-90, 90] ne peut venir que d'un
  // client cassé ou malveillant, et fausserait les calculs d'ETA du tracking.
  @IsNumber()
  @Min(-90)
  @Max(90)
  @IsOptional()
  deliveryLatitude?: number;

  @IsNumber()
  @Min(-180)
  @Max(180)
  @IsOptional()
  deliveryLongitude?: number;

  // Multi-vendeurs (LIL-112)
  @IsBoolean()
  @IsOptional()
  isPreorder?: boolean;

  @IsDateString()
  @IsOptional()
  scheduledFor?: string; // ISO 8601

  /**
   * F3-11 — l'offre boutique que le client a vue dans son récapitulatif
   * (`POST /orders/quote`), ou `null` s'il n'en a vu aucune. Si le serveur
   * n'applique pas la même au moment du checkout, 409 `VENDOR_OFFER_CHANGED` :
   * on n'encaisse jamais un total autre que celui affiché.
   *
   * Absent (`undefined`) = application antérieure à F3-11 : l'offre éventuelle
   * s'applique sans vérification — elle ne peut que baisser le total.
   */
  @IsString()
  @MaxLength(64)
  @IsOptional()
  vendorOfferId?: string | null;
}

/**
 * Devis du panier (F3-11) : mêmes entrées que le checkout, sans ce qui ne
 * sert qu'à créer la commande. Le mode de paiement n'influe sur aucun montant.
 */
export class QuoteOrderDto extends OmitType(CreateOrderDto, [
  'paymentMethod',
  'notes',
  'contactPhone',
  'vendorOfferId',
] as const) {
  /**
   * Livraison vers une adresse **pas encore enregistrée** : l'app mobile ne
   * crée l'adresse qu'au paiement. Le quartier suffit à chiffrer la course
   * (même base que `GET /quartiers/delivery-fee`). Ignoré si `adresseId` est
   * fourni — l'adresse enregistrée fait alors foi.
   */
  @IsString()
  @MaxLength(64)
  @IsOptional()
  quartierId?: string;
}
