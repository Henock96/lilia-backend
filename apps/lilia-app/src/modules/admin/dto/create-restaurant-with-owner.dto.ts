import {
  IsArray,
  IsBoolean,
  IsEmail,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { VendorType } from '@prisma/client';

export class CreateRestaurantWithOwnerDto {
  // User fields
  @IsNotEmpty()
  ownerFirebaseUid: string;

  @IsEmail()
  @IsNotEmpty()
  email: string;

  @IsString()
  @IsNotEmpty()
  @MinLength(6)
  password: string;

  @IsString()
  @IsNotEmpty()
  nom: string;

  @IsString()
  @IsOptional()
  phone?: string;

  // Restaurant fields
  @IsString()
  @IsNotEmpty()
  restaurantNom: string;

  @IsString()
  @IsNotEmpty()
  restaurantAdresse: string;

  @IsString()
  @IsNotEmpty()
  restaurantPhone: string;

  @IsString()
  @IsOptional()
  restaurantImageUrl?: string;

  // Type de vendeur — défaut RESTAURANT pour préserver le flux existant.
  // Tout type non-RESTAURANT crée le vendeur avec adminApproved=false.
  @IsEnum(VendorType)
  @IsOptional()
  vendorType?: VendorType;

  // HOME_COOK / BAKERY : précommandes
  @IsBoolean()
  @IsOptional()
  acceptsPreorders?: boolean;

  @IsInt()
  @IsOptional()
  @Min(1)
  @Max(168)
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
  @MaxLength(500)
  productionNote?: string;
}
