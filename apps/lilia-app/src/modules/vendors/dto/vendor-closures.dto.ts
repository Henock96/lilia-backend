import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsDate,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

/** Plafond d'une pause (R-03.2) : au-delà, c'est un congé. */
export const MAX_PAUSE_MINUTES = 7 * 24 * 60;

/**
 * `POST /vendors/:id/pause` — `minutes` **ou** `until`, jamais les deux.
 * L'heure est calculée par le serveur ; `until` n'est qu'une échéance, bornée.
 */
export class PauseVendorDto {
  @IsOptional()
  @IsInt({ message: 'minutes doit être un entier.' })
  @Min(5)
  @Max(MAX_PAUSE_MINUTES)
  minutes?: number;

  @IsOptional()
  @Type(() => Date)
  @IsDate({ message: 'until doit être une date.' })
  until?: Date;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  reason?: string;
}

/** `POST /vendors/:id/closures` — congé daté. */
export class CreateVendorClosureDto {
  @Type(() => Date)
  @IsDate({ message: 'startsAt doit être une date.' })
  startsAt: Date;

  @Type(() => Date)
  @IsDate({ message: 'endsAt doit être une date.' })
  endsAt: Date;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  reason?: string;
}

export class UpdateClosedOnHolidaysDto {
  @IsBoolean()
  closedOnHolidays: boolean;
}

export class CreatePublicHolidayDto {
  /** « AAAA-MM-JJ » — jour civil de Brazzaville. */
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'date attendue au format AAAA-MM-JJ.',
  })
  date: string;

  @IsString()
  @MinLength(2)
  @MaxLength(80)
  label: string;
}
