/* eslint-disable prettier/prettier */
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { DeliveryPriceMode, VendorType } from '@prisma/client';

export class CreateVendorDto {
  @IsEnum(VendorType)
  vendorType: VendorType;

  @IsString()
  @IsNotEmpty()
  nom: string;

  @IsString()
  @IsNotEmpty()
  adresse: string;

  @IsString()
  @IsNotEmpty()
  phone: string;

  @IsNumber()
  @IsOptional()
  latitude?: number;

  @IsNumber()
  @IsOptional()
  longitude?: number;

  @IsString()
  @IsOptional()
  imageUrl?: string;

  // Livraison
  @IsEnum(DeliveryPriceMode)
  @IsOptional()
  deliveryPriceMode?: DeliveryPriceMode;

  @IsNumber()
  @IsOptional()
  @Min(0)
  fixedDeliveryFee?: number;

  @IsNumber()
  @IsOptional()
  @Min(0)
  minimumOrderAmount?: number;

  // BEVERAGE_SHOP : alcool
  @IsInt()
  @IsOptional()
  @Min(18)
  @Max(21)
  minAgeRequired?: number;

  // HOME_COOK / BAKERY : précommandes
  @IsBoolean()
  @IsOptional()
  acceptsPreorders?: boolean;

  @IsInt()
  @IsOptional()
  @Min(1)
  @Max(168) // 1h à 7 jours
  preorderLeadHours?: number;

  @IsInt()
  @IsOptional()
  @Min(1)
  maxOrdersPerDay?: number;

  // Profil enrichi (créé si au moins un champ fourni)
  @IsString()
  @IsOptional()
  @MaxLength(2000)
  story?: string;

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  certifications?: string[];

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  specialties?: string[];

  @IsString()
  @IsOptional()
  licenseNumber?: string;

  @IsString()
  @IsOptional()
  @MaxLength(500)
  productionNote?: string;

  // Le owner (User.id) est requis : un vendeur appartient à un user RESTAURATEUR
  @IsString()
  @IsNotEmpty()
  ownerId: string;
}
