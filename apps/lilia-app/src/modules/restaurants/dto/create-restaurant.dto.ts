/* eslint-disable prettier/prettier */
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { DeliveryPriceMode } from '@prisma/client';

/**
 * Plafonds partagés avec `UpdateVendorDeliveryDto` (`vendors/dto/onboarding.dto.ts`).
 *
 * Les deux DTOs écrivent **les mêmes colonnes** par deux routes différentes
 * (`PATCH /restaurants/:id/delivery-settings` et `PATCH /vendors/:id/delivery`)
 * et ne les validaient pas pareil : l'un bornait, l'autre non. Un plafond
 * déclaré à deux endroits finit toujours par diverger — ils sont donc définis
 * ici et importés là-bas.
 */
export const MAX_DELIVERY_FEE_XAF = 100_000;
export const MAX_DELIVERY_MINUTES = 600;

export class CreateRestaurantDto {
    @IsString()
    nom: string;

    @IsString()
    adresse: string;

    @IsString()
    phone: string;

    @IsOptional()
    @IsString()
    imageUrl?: string;

    @IsOptional()
    @IsArray()
    @IsString({ each: true })
    specialties?: string[]; // Liste des spécialités à créer avec le restaurant
}

// DTO pour mettre à jour les paramètres de livraison
export class UpdateDeliverySettingsDto {
    @IsOptional()
    @IsInt({ message: 'Un montant en francs CFA est un nombre entier — le XAF n’a pas de sous-unité.' })
    @Min(0)
    @Max(MAX_DELIVERY_FEE_XAF, { message: 'Frais de livraison hors limites.' })
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

    @IsOptional()
    @IsInt({ message: 'Un montant en francs CFA est un nombre entier — le XAF n’a pas de sous-unité.' })
    @Min(0)
    @Max(MAX_DELIVERY_FEE_XAF, { message: 'Montant minimum hors limites.' })
    minimumOrderAmount?: number;

    /**
     * ⚠️ Ce champ était validé par `@IsString()` (fix L-4, audit du 05/09/2026).
     *
     * L'annotation TypeScript `'FIXED' | 'ZONE_BASED'` ne vaut rien à
     * l'exécution : `{"deliveryPriceMode": "GRATUIT"}` passait class-validator,
     * atteignait Prisma, et remontait en **500** — une erreur d'infrastructure
     * pour ce qui est une saisie invalide. La route jumelle
     * `PATCH /vendors/:id/delivery` faisait déjà `@IsEnum`.
     */
    @IsOptional()
    @IsEnum(DeliveryPriceMode, {
      message: 'Mode de livraison invalide : attendu FIXED ou ZONE_BASED.',
    })
    deliveryPriceMode?: DeliveryPriceMode;
}

// DTO pour mettre à jour le statut d'ouverture
export class UpdateOpenStatusDto {
    @IsBoolean()
    isOpen: boolean;
}

// DTO pour ajouter une spécialité
export class AddSpecialtyDto {
    @IsString()
    name: string;
}

// DTO pour mettre à jour le restaurant
//
// ⚠️ Ne jamais y ajouter `commissionPercent` : cette route est ouverte au
// RESTAURATEUR, qui fixerait alors lui-même la marge de la plateforme. La
// commission se règle par `PATCH /admin/vendors/:id/commerce`, réservé à
// l'ADMIN et tracé dans `AdminAuditLog`. `whitelist: true` sur le
// ValidationPipe global écarte le champ s'il est tout de même envoyé.
export class UpdateRestaurantDto {
    @IsOptional()
    @IsString()
    nom?: string;

    @IsOptional()
    @IsString()
    adresse?: string;

    @IsOptional()
    @IsString()
    phone?: string;

    @IsOptional()
    @IsString()
    imageUrl?: string;

    // LIL-127 : pilotage pré-commande (LIL-121) par le vendeur lui-même.
    // Le restaurateur peut activer/désactiver, ajuster son délai mini
    // de préparation et son plafond quotidien. `preorderLeadHours` et
    // `maxOrdersPerDay` à null = pas de limite (sémantique backend).
    @IsOptional()
    @IsBoolean()
    acceptsPreorders?: boolean;

    @IsOptional()
    @IsInt()
    @Min(1)
    @Max(168) // 7 jours, aligné sur la fenêtre max validateur
    preorderLeadHours?: number;

    @IsOptional()
    @IsInt()
    @Min(1)
    maxOrdersPerDay?: number;
}