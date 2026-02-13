/* eslint-disable prettier/prettier */
import { IsArray, IsBoolean, IsEnum, IsOptional, IsString, Matches, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

export enum DayOfWeek {
    LUNDI = 'LUNDI',
    MARDI = 'MARDI',
    MERCREDI = 'MERCREDI',
    JEUDI = 'JEUDI',
    VENDREDI = 'VENDREDI',
    SAMEDI = 'SAMEDI',
    DIMANCHE = 'DIMANCHE',
}

export class OperatingHourDto {
    @IsEnum(DayOfWeek)
    dayOfWeek: DayOfWeek;

    @IsString()
    @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, { message: 'openTime doit être au format HH:mm' })
    openTime: string;

    @IsString()
    @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, { message: 'closeTime doit être au format HH:mm' })
    closeTime: string;

    @IsOptional()
    @IsBoolean()
    isClosed?: boolean;
}

export class SetOperatingHoursDto {
    @IsArray()
    @ValidateNested({ each: true })
    @Type(() => OperatingHourDto)
    hours: OperatingHourDto[];
}

export class UpdateOperatingHourDto {
    @IsOptional()
    @IsString()
    @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, { message: 'openTime doit être au format HH:mm' })
    openTime?: string;

    @IsOptional()
    @IsString()
    @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, { message: 'closeTime doit être au format HH:mm' })
    closeTime?: string;

    @IsOptional()
    @IsBoolean()
    isClosed?: boolean;
}
