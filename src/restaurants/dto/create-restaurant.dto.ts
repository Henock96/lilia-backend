/* eslint-disable prettier/prettier */
import { IsString, IsOptional, IsNumber, IsBoolean, IsArray, Min } from 'class-validator';

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
    @IsNumber()
    @Min(0)
    fixedDeliveryFee?: number;

    @IsOptional()
    @IsNumber()
    @Min(0)
    estimatedDeliveryTimeMin?: number;

    @IsOptional()
    @IsNumber()
    @Min(0)
    estimatedDeliveryTimeMax?: number;

    @IsOptional()
    @IsNumber()
    @Min(0)
    minimumOrderAmount?: number;

    @IsOptional()
    @IsString()
    deliveryPriceMode?: 'FIXED' | 'ZONE_BASED';
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
}