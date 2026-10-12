import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { DayOfWeek } from '../../restaurants/dto/operating-hours.dto';
import {
  RESERVATION_SPACE_KINDS,
  ReservationSpaceKind,
} from '../reservation-vocab';

/**
 * Premium (Lot 3) — corps de la prévisualisation et de l'enregistrement.
 *
 * Le DTO ne contrôle que la **forme** (types, tailles de tableau). Les règles
 * métier (D5–D10, D15) et les caractères interdits des libellés sont vérifiés
 * par le moteur `reservation-config.ts`, qui rend un constat par champ avec un
 * message en français : un aperçu doit pouvoir montrer TOUTES les erreurs d'un
 * brouillon, sous le bon champ — un 400 de DTO n'a ni `error.code` ni champ.
 */

export class ReservationSpaceDto {
  @ApiPropertyOptional({
    description: 'Ressource existante de VOTRE restaurant ; absent = nouvelle',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  id?: string;

  @ApiProperty({ enum: RESERVATION_SPACE_KINDS })
  @IsIn(RESERVATION_SPACE_KINDS)
  kind: ReservationSpaceKind;

  @ApiProperty({ description: '1 à 40 caractères après normalisation' })
  @IsString()
  @MaxLength(200)
  label: string;

  @ApiPropertyOptional({ description: 'TABLE : groupe minimum' })
  @IsOptional()
  @IsInt()
  minGuests?: number;

  @ApiPropertyOptional({ description: 'TABLE : groupe maximum' })
  @IsOptional()
  @IsInt()
  maxGuests?: number;

  @ApiPropertyOptional({ description: 'SEATS : nombre de places' })
  @IsOptional()
  @IsInt()
  seatCount?: number;

  @ApiPropertyOptional({
    description: 'SEATS : places au plus par réservation',
  })
  @IsOptional()
  @IsInt()
  maxSeatsPerBooking?: number;

  @ApiPropertyOptional({
    description: 'Seule façon d’archiver une ressource : jamais par omission',
  })
  @IsOptional()
  @IsBoolean()
  archived?: boolean;
}

export class ReservationWindowDto {
  @ApiProperty({ enum: DayOfWeek })
  @IsIn(Object.values(DayOfWeek))
  dayOfWeek: DayOfWeek;

  @ApiProperty({ example: '12:00' })
  @IsString()
  @MaxLength(5)
  startTime: string;

  @ApiProperty({ example: '14:00', description: 'Dernière arrivée, incluse' })
  @IsString()
  @MaxLength(5)
  endTime: string;
}

export class ReservationDraftDto {
  @ApiProperty()
  @IsBoolean()
  enabled: boolean;

  @ApiProperty({ example: 90 })
  @IsInt()
  slotDurationMin: number;

  @ApiProperty({ example: 30 })
  @IsInt()
  slotStepMin: number;

  @ApiProperty({ example: 15 })
  @IsInt()
  bufferMin: number;

  @ApiProperty({ example: 120 })
  @IsInt()
  minLeadMin: number;

  @ApiProperty({ example: 30 })
  @IsInt()
  maxAdvanceDays: number;

  @ApiProperty({ example: 8 })
  @IsInt()
  maxPartySize: number;

  @ApiProperty({ type: [ReservationSpaceDto] })
  @IsArray()
  @ArrayMaxSize(120)
  @ValidateNested({ each: true })
  @Type(() => ReservationSpaceDto)
  spaces: ReservationSpaceDto[];

  @ApiProperty({ type: [ReservationWindowDto] })
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => ReservationWindowDto)
  windows: ReservationWindowDto[];
}

export class SaveReservationSettingsDto extends ReservationDraftDto {
  @ApiProperty({
    description:
      'Version lue (`config.version`, 0 si aucune configuration) — verrou optimiste',
  })
  @IsInt()
  @Min(0)
  version: number;
}
