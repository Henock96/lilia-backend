import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsEnum,
  IsInt,
  IsLatitude,
  IsLongitude,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { DeliveryPriceMode, VendorType } from '@prisma/client';
import { OperatingHourDto } from '../../restaurants/dto/operating-hours.dto';
import {
  MAX_DELIVERY_FEE_XAF,
  MAX_DELIVERY_MINUTES,
} from '../../restaurants/dto/create-restaurant.dto';

/**
 * Format des numéros congolais : 9 chiffres en local (`060000000`) ou format
 * international `+242…`. Le modèle n'imposait aucun format, si bien qu'un
 * `"abc"` finissait en base sur le champ qui sert à joindre le vendeur quand
 * une commande pose problème.
 */
export const CG_PHONE_REGEX = /^(?:\+?242)?0?\d{9}$/;
const PHONE_MESSAGE =
  'Numéro invalide. Formats acceptés : 060000000 ou +242060000000.';

/** Étape 1 — création du vendeur et de son compte propriétaire. */
export class CreateVendorOnboardingDto {
  @IsEnum(VendorType)
  vendorType: VendorType;

  // ── Propriétaire ──────────────────────────────────────────────────────────
  // Aucun champ `password` : l'administrateur ne choisit pas le mot de passe du
  // vendeur. Un secret connu de l'admin, transmis par WhatsApp et jamais changé
  // n'est pas un secret. Le compte est créé avec un mot de passe jetable et le
  // vendeur définit le sien via le lien d'activation Firebase.

  @IsEmail({}, { message: 'Email du propriétaire invalide.' })
  @IsNotEmpty()
  @MaxLength(320)
  ownerEmail: string;

  @IsString()
  @IsNotEmpty()
  @MinLength(2)
  @MaxLength(120)
  ownerNom: string;

  @IsString()
  @IsNotEmpty()
  @Matches(CG_PHONE_REGEX, { message: PHONE_MESSAGE })
  ownerPhone: string;

  // ── Commerce ──────────────────────────────────────────────────────────────

  @IsString()
  @IsNotEmpty()
  @MinLength(2)
  @MaxLength(120)
  nom: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(300)
  adresse: string;

  @IsString()
  @IsNotEmpty()
  @Matches(CG_PHONE_REGEX, { message: PHONE_MESSAGE })
  phone: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;
}

/** Étape 2 & 3 — identité et visuels. */
export class UpdateVendorIdentityDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  nom?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsOptional()
  @IsString()
  @Matches(CG_PHONE_REGEX, { message: PHONE_MESSAGE })
  phone?: string;

  @IsOptional()
  @IsEmail({}, { message: 'Email de contact invalide.' })
  @MaxLength(320)
  email?: string;

  /** URL Cloudinary du logo, obtenue via `POST /upload/image`. */
  @IsOptional()
  @IsString()
  @MaxLength(600)
  imageUrl?: string;

  /**
   * `public_id` Cloudinary retourné par le même appel. Le fournir permet de
   * supprimer l'image précédente au remplacement ; l'omettre laisse une
   * orpheline, ce que les fronts évitent en transmettant les deux.
   */
  @IsOptional()
  @IsString()
  @MaxLength(300)
  imagePublicId?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(20)
  @MaxLength(60, { each: true })
  specialties?: string[];
}

/** Étape 4 — localisation. */
export class UpdateVendorLocationDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(300)
  adresse?: string;

  @IsOptional()
  @IsString()
  quartierId?: string;

  // `@IsLatitude` / `@IsLongitude` rejettent NaN et Infinity, que `@IsNumber`
  // laisse passer. Les bornes Congo sont vérifiées par VendorReadinessService :
  // ici on refuse ce qui n'est pas une coordonnée, là-bas ce qui n'est pas au
  // Congo — un admin doit pouvoir enregistrer un point approximatif et le
  // corriger, sans être bloqué au milieu de sa saisie.
  @IsOptional()
  @IsLatitude({ message: 'Latitude invalide.' })
  @Type(() => Number)
  latitude?: number;

  @IsOptional()
  @IsLongitude({ message: 'Longitude invalide.' })
  @Type(() => Number)
  longitude?: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  deliveryInstructions?: string;
}

/** Étape 5 — horaires. Réutilise le DTO existant du module restaurants. */
export class UpdateVendorHoursDto {
  @IsArray()
  @ArrayMaxSize(7)
  @ValidateNested({ each: true })
  @Type(() => OperatingHourDto)
  hours: OperatingHourDto[];
}

/** Étape 6 — livraison et retrait. */
export class UpdateVendorDeliveryDto {
  @IsOptional()
  @IsBoolean()
  supportsDelivery?: boolean;

  @IsOptional()
  @IsBoolean()
  supportsPickup?: boolean;

  @IsOptional()
  @IsEnum(DeliveryPriceMode)
  deliveryPriceMode?: DeliveryPriceMode;

  @IsOptional()
  @IsInt({ message: 'Un montant en XAF est un entier — pas de sous-unité.' })
  @Min(0)
  @Max(MAX_DELIVERY_FEE_XAF)
  fixedDeliveryFee?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_DELIVERY_MINUTES)
  estimatedDeliveryTimeMin?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_DELIVERY_MINUTES)
  estimatedDeliveryTimeMax?: number;

  /**
   * Le minimum de commande manquait ici alors qu'il est réglé dans le même
   * écran que le reste de la livraison. Sans lui, l'admin devait passer par
   * `PATCH /restaurants/:id/delivery-settings` pour ce seul champ — deux routes
   * pour un formulaire, donc deux façons de se tromper.
   */
  @IsOptional()
  @IsInt({ message: 'Un montant en XAF est un entier — pas de sous-unité.' })
  @Min(0)
  @Max(MAX_DELIVERY_FEE_XAF)
  minimumOrderAmount?: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  deliveryInstructions?: string;
}

/**
 * Étape 7 — paramètres commerciaux. **ADMIN uniquement** : ce DTO porte la
 * commission, c'est-à-dire la marge de la plateforme.
 */
export class UpdateVendorCommerceDto {
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(50)
  commissionPercent?: number | null;

  @IsOptional()
  @IsInt({ message: 'Un montant en XAF est un entier — pas de sous-unité.' })
  @Min(0)
  @Max(1_000_000)
  minimumOrderAmount?: number;

  @IsOptional()
  @IsBoolean()
  acceptsPreorders?: boolean;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(168)
  preorderLeadHours?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  maxOrdersPerDay?: number;
}

/** Étape 10 — activation. */
export class ActivateVendorDto {
  /**
   * Passe outre les cases **non bloquantes** manquantes (description, photo de
   * couverture). Ne contourne jamais une case bloquante : celles-là décrivent
   * ce sans quoi un client vivrait une mauvaise expérience.
   */
  @IsOptional()
  @IsBoolean()
  skipRecommendations?: boolean;
}
