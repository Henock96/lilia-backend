import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PaymentMethod } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

import { PaginationQueryDto } from '../../../common/pagination/pagination-query.dto';
import { IsCongoMobilePhone } from '../../../common/validation/congo-phone.decorator';
import {
  RESERVATION_DECLINE_REASONS,
  RESERVATION_STATUSES,
  RESERVATION_VENDOR_CANCEL_REASONS,
  ReservationDeclineReason,
  ReservationStatus,
  ReservationVendorCancelReason,
} from '../reservation-booking-vocab';
import { VISIBLE_TEXT_WITH_NEWLINES } from '../reservation-config';
import { RESERVATION_LIMITS } from '../reservation-vocab';

/**
 * Lot 4 — corps et paramètres des routes de réservation.
 *
 * Le DTO borne la **forme** ; la disponibilité, la capacité, les délais et
 * l'éligibilité sont jugés par le serveur (moteur `reservation-availability`,
 * machine d'états), jamais par l'app.
 */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const HH_MM = /^([01]\d|2[0-3]):[0-5]\d$/;
const PARTY_MAX = RESERVATION_LIMITS.maxPartySize.max;

export class AvailabilityQueryDto {
  @ApiPropertyOptional({
    description:
      'Jour civil de Brazzaville (AAAA-MM-JJ). Absent = seulement les bornes.',
  })
  @IsOptional()
  @Matches(ISO_DATE, { message: 'date doit être au format AAAA-MM-JJ' })
  date?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: PARTY_MAX, default: 2 })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'partySize doit être un entier' })
  @Min(1)
  @Max(PARTY_MAX)
  partySize?: number;
}

export class CreateReservationDto {
  @ApiProperty()
  @IsString()
  @MaxLength(64)
  restaurantId!: string;

  @ApiProperty({ description: 'Jour civil de Brazzaville (AAAA-MM-JJ)' })
  @Matches(ISO_DATE, { message: 'date doit être au format AAAA-MM-JJ' })
  date!: string;

  @ApiProperty({
    description: 'Heure d’arrivée proposée par le serveur (HH:mm)',
  })
  @Matches(HH_MM, { message: 'time doit être au format HH:mm' })
  time!: string;

  @ApiProperty({ minimum: 1, maximum: PARTY_MAX })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(PARTY_MAX)
  partySize!: number;

  @ApiPropertyOptional({
    description:
      'Téléphone de contact ; absent = celui du compte (obligatoire au final)',
  })
  @IsOptional()
  @IsCongoMobilePhone()
  contactPhone?: string;

  @ApiPropertyOptional({ maxLength: 280 })
  @IsOptional()
  @IsString()
  @MaxLength(280)
  @Matches(VISIBLE_TEXT_WITH_NEWLINES, {
    message: 'La note contient des caractères invisibles non autorisés.',
  })
  note?: string;
}

export class MyReservationsQueryDto extends PaginationQueryDto {}

export class VendorReservationsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    description: 'Jour civil de Brazzaville (AAAA-MM-JJ)',
  })
  @IsOptional()
  @Matches(ISO_DATE, { message: 'date doit être au format AAAA-MM-JJ' })
  date?: string;

  @ApiPropertyOptional({ enum: RESERVATION_STATUSES })
  @IsOptional()
  @IsIn(RESERVATION_STATUSES)
  status?: ReservationStatus;
}

export class DeclineReservationDto {
  @ApiProperty({ enum: RESERVATION_DECLINE_REASONS })
  @IsIn(RESERVATION_DECLINE_REASONS)
  reason!: ReservationDeclineReason;
}

/** J6 — annulation par le support : motif libre, obligatoire, journalisé. */
export class AdminCancelReservationDto {
  @ApiProperty({ minLength: 10, maxLength: 500 })
  @IsString()
  @MinLength(10, { message: 'Motif obligatoire (10 caractères au moins).' })
  @MaxLength(500)
  reason!: string;
}

export class VendorCancelReservationDto {
  @ApiProperty({ enum: RESERVATION_VENDOR_CANCEL_REASONS })
  @IsIn(RESERVATION_VENDOR_CANCEL_REASONS)
  reason!: ReservationVendorCancelReason;
}

export class ReassignReservationDto {
  @ApiProperty({ description: 'Ressource de VOTRE restaurant, du même type' })
  @IsString()
  @MaxLength(64)
  spaceId!: string;
}

/**
 * 4B-2 — `POST /reservations/:id/pay`. Aucun montant à facturer : le serveur
 * prend celui de la commande liée. `expectedTotal` est le total que le client
 * a vu, pour refuser un écran périmé (OD-04).
 */
export class PayReservationDto {
  @ApiProperty({ description: 'Total affiché au client (XAF entiers)' })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(100_000_000)
  expectedTotal!: number;

  @ApiProperty({ description: 'Numéro mobile money qui paie' })
  @IsCongoMobilePhone()
  phoneNumber!: string;

  @ApiProperty({ enum: PaymentMethod })
  @IsEnum(PaymentMethod, {
    message: 'Opérateur invalide (MTN_MOMO ou AIRTEL_MONEY).',
  })
  method!: PaymentMethod;
}
