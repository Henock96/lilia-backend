import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEmail,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import {
  DriverCompensationModel,
  DriverEmploymentType,
  DriverStatus,
  VehicleType,
} from '@prisma/client';

import { MAX_SHARE_PERCENT } from '../../payments/money.util';

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

  /**
   * Nature de la relation — décide du taux par défaut ET de qui supporte les
   * coûts du véhicule. Un `INDEPENDENT` apporte sa moto et paie carburant,
   * entretien et assurance : ces coûts ne sont jamais des charges de Lilia.
   *
   * Omis ⇒ `LILIA`, le défaut du schéma.
   */
  @ApiPropertyOptional({ enum: DriverEmploymentType })
  @IsOptional()
  @IsEnum(DriverEmploymentType)
  employmentType?: DriverEmploymentType;

  /** Modèle de rémunération. Omis ⇒ `PER_DELIVERY`, le seul actif aujourd'hui. */
  @ApiPropertyOptional({ enum: DriverCompensationModel })
  @IsOptional()
  @IsEnum(DriverCompensationModel)
  compensationModel?: DriverCompensationModel;

  /**
   * Part de CE livreur sur les frais de livraison, en pourcentage.
   * Omis ou `null` ⇒ taux plateforme correspondant à son `employmentType`.
   *
   * ⚠️ C'est la part **du livreur**, jamais celle de Lilia. Borné à
   * `MAX_SHARE_PERCENT` (100) et non au plafond de commission (50) : un
   * indépendant touche 65 %, l'y soumettre le ramènerait à 50 % en silence.
   */
  @ApiPropertyOptional({ minimum: 0, maximum: MAX_SHARE_PERCENT })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(MAX_SHARE_PERCENT)
  driverSharePercent?: number | null;
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

  /** Voir `CreateDriverDto.employmentType`. */
  @ApiPropertyOptional({ enum: DriverEmploymentType })
  @IsOptional()
  @IsEnum(DriverEmploymentType)
  employmentType?: DriverEmploymentType;

  /** Voir `CreateDriverDto.compensationModel`. */
  @ApiPropertyOptional({ enum: DriverCompensationModel })
  @IsOptional()
  @IsEnum(DriverCompensationModel)
  compensationModel?: DriverCompensationModel;

  /**
   * Voir `CreateDriverDto.driverSharePercent`. Envoyer `null` remet
   * explicitement le livreur au taux plateforme de son type.
   */
  @ApiPropertyOptional({ minimum: 0, maximum: MAX_SHARE_PERCENT })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(MAX_SHARE_PERCENT)
  driverSharePercent?: number | null;
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
