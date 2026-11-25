import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PaymentMethod } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

import { IsCongoMobilePhone } from '../../../common/validation/congo-phone.decorator';
import { PaginationQueryDto } from '../../../common/pagination/pagination-query.dto';
import {
  SUBSCRIPTION_DURATIONS_MONTHS,
  SUBSCRIPTION_PAYMENT_STATUSES,
  SubscriptionDurationMonths,
} from '../plans';

/**
 * Premium S1 — payer son abonnement dans la plateforme. Ni montant ni prix :
 * le serveur les lit dans `PlatformSettings` et les fige sur la tentative.
 */
export class StartSubscriptionPaymentDto {
  @ApiProperty({ enum: SUBSCRIPTION_DURATIONS_MONTHS })
  @Type(() => Number)
  @IsInt()
  @IsIn(SUBSCRIPTION_DURATIONS_MONTHS, {
    message: 'Durée proposée : 1, 3, 6 ou 12 mois.',
  })
  months: SubscriptionDurationMonths;

  @ApiProperty({ description: 'Numéro Mobile Money qui paie (Congo).' })
  @IsString()
  @IsNotEmpty({ message: 'Le numéro de téléphone est requis.' })
  @IsCongoMobilePhone()
  phoneNumber: string;

  @ApiProperty({ enum: PaymentMethod })
  @IsEnum(PaymentMethod, { message: 'Opérateur : MTN_MOMO ou AIRTEL_MONEY.' })
  method: PaymentMethod;
}

export class AdminSubscriptionPaymentsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: SUBSCRIPTION_PAYMENT_STATUSES })
  @IsOptional()
  @IsIn(SUBSCRIPTION_PAYMENT_STATUSES)
  status?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(64)
  restaurantId?: string;
}
