import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEmail,
  IsEnum,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { DriverStatus, VehicleType } from '@prisma/client';

/**
 * Numéro congolais, même expression que `UpdateUserDto` : le livreur est
 * joignable par le client et le vendeur pendant la course, un numéro faux le
 * rend injoignable au pire moment.
 */
const CONGO_PHONE = /^(\+?242)?0?[456]\d{7}$/;

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

/** Chaîne vide ⇒ `undefined` : un champ laissé vide dans un formulaire n'est
 *  pas une valeur, c'est une absence de valeur. */
const trimToUndefined = ({ value }: { value: unknown }) => {
  if (typeof value !== 'string') return value;
  const t = value.trim();
  return t.length === 0 ? undefined : t;
};

export class CreateDriverDto {
  @ApiProperty({ example: 'jean.mabiala@example.cg' })
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsEmail({}, { message: 'Adresse e-mail invalide.' })
  @MaxLength(180)
  email: string;

  @ApiProperty({ example: 'Jean Mabiala', description: 'Prénom et nom' })
  @Transform(trim)
  @IsString()
  @MinLength(2, { message: 'Le nom doit contenir au moins 2 caractères.' })
  @MaxLength(80)
  nom: string;

  @ApiProperty({ example: '061234567' })
  @Transform(trim)
  @IsString()
  @Matches(CONGO_PHONE, {
    message: 'Numéro de téléphone congolais invalide (ex : 06 123 45 67).',
  })
  phone: string;

  @ApiPropertyOptional({ description: 'URL Cloudinary de la photo' })
  @Transform(trimToUndefined)
  @IsOptional()
  @IsString()
  @MaxLength(500)
  imageUrl?: string;

  @ApiProperty({ enum: VehicleType, default: VehicleType.MOTO })
  @IsEnum(VehicleType)
  vehicleType: VehicleType;

  @ApiPropertyOptional({
    description: 'Immatriculation — inutile à vélo ou à pied',
  })
  @Transform(trimToUndefined)
  @IsOptional()
  @IsString()
  @MaxLength(20)
  plateNumber?: string;

  @ApiPropertyOptional()
  @Transform(trimToUndefined)
  @IsOptional()
  @IsString()
  @MaxLength(40)
  licenseNumber?: string;

  @ApiPropertyOptional({ description: 'ISO 8601' })
  @IsOptional()
  @IsDateString()
  licenseExpiry?: string;

  @ApiPropertyOptional({
    type: [String],
    description:
      'Identifiants de quartiers. Vide = toute la ville (comportement par défaut).',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(40)
  zoneIds?: string[];
}

export class UpdateDriverDto {
  @ApiPropertyOptional()
  @Transform(trim)
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  nom?: string;

  @ApiPropertyOptional()
  @Transform(trim)
  @IsOptional()
  @IsString()
  @Matches(CONGO_PHONE, {
    message: 'Numéro de téléphone congolais invalide (ex : 06 123 45 67).',
  })
  phone?: string;

  @ApiPropertyOptional()
  @Transform(trimToUndefined)
  @IsOptional()
  @IsString()
  @MaxLength(500)
  imageUrl?: string;

  @ApiPropertyOptional({ enum: VehicleType })
  @IsOptional()
  @IsEnum(VehicleType)
  vehicleType?: VehicleType;

  @ApiPropertyOptional()
  @Transform(trimToUndefined)
  @IsOptional()
  @IsString()
  @MaxLength(20)
  plateNumber?: string;

  @ApiPropertyOptional()
  @Transform(trimToUndefined)
  @IsOptional()
  @IsString()
  @MaxLength(40)
  licenseNumber?: string;

  @ApiPropertyOptional({ description: 'ISO 8601' })
  @IsOptional()
  @IsDateString()
  licenseExpiry?: string;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(40)
  zoneIds?: string[];
}

/**
 * Ce qu'un livreur peut corriger LUI-MÊME.
 *
 * Volontairement plus étroit que `UpdateDriverDto` : le véhicule, la plaque, le
 * permis et les zones engagent la plateforme vis-à-vis du client et relèvent
 * d'un contrôle administratif. Laisser le livreur les modifier viderait de son
 * sens le fait de les avoir vérifiés.
 */
export class UpdateMyDriverProfileDto {
  @ApiPropertyOptional()
  @Transform(trim)
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  nom?: string;

  @ApiPropertyOptional()
  @Transform(trim)
  @IsOptional()
  @IsString()
  @Matches(CONGO_PHONE, {
    message: 'Numéro de téléphone congolais invalide (ex : 06 123 45 67).',
  })
  phone?: string;

  @ApiPropertyOptional()
  @Transform(trimToUndefined)
  @IsOptional()
  @IsString()
  @MaxLength(500)
  imageUrl?: string;
}

export class DeactivateDriverDto {
  @ApiPropertyOptional({ description: 'Motif, conservé sur le profil' })
  @Transform(trimToUndefined)
  @IsOptional()
  @IsString()
  @MaxLength(300)
  reason?: string;
}

/**
 * Filtres de la liste d'administration.
 *
 * `isActive` et `statusUser` portent sur deux objets différents — le profil
 * métier et le compte — et `driverStatus` sur un troisième, la disponibilité du
 * moment. Les trois sont donc trois filtres, pas un seul « statut ».
 */
export class DriverFilterDto {
  @ApiPropertyOptional({ description: 'Nom, e-mail ou téléphone' })
  @Transform(trimToUndefined)
  @IsOptional()
  @IsString()
  @MaxLength(80)
  search?: string;

  @ApiPropertyOptional({ description: 'Profil métier actif' })
  @IsOptional()
  @Transform(({ value }) =>
    value === undefined || value === ''
      ? undefined
      : value === 'true' || value === true,
  )
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({ enum: DriverStatus, description: 'Disponibilité' })
  @IsOptional()
  @IsEnum(DriverStatus)
  driverStatus?: DriverStatus;

  @ApiPropertyOptional({ description: 'Statut du compte : ACTIVE | BLOCKED' })
  @IsOptional()
  @IsString()
  @IsEnum(['ACTIVE', 'BLOCKED', 'DELETED', 'INACTIVE'], {
    message: 'statusUser doit valoir ACTIVE, BLOCKED, INACTIVE ou DELETED.',
  })
  statusUser?: 'ACTIVE' | 'BLOCKED' | 'DELETED' | 'INACTIVE';
}
