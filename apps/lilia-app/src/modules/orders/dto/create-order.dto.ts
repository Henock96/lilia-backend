import { IsString, IsNotEmpty, IsEnum, IsOptional, IsBoolean, IsNumber, IsDateString } from 'class-validator';
import { PaymentMethod } from '@prisma/client';
import { Transform } from 'class-transformer';

export class CreateOrderDto {
  @IsString()
  @IsOptional()
  adresseId?: string;

  @IsEnum(PaymentMethod)
  @IsNotEmpty()
  paymentMethod: PaymentMethod;

  @IsString()
  @IsOptional()
  notes?: string;

  @IsBoolean()
  @IsOptional()
  @Transform(({ value }) => value ?? true)
  isDelivery?: boolean = true;

  @IsString()
  @IsOptional()
  contactPhone?: string;

  @IsOptional()
  @IsString()
  promoCode?: string;

  @IsBoolean()
  @IsOptional()
  useLoyaltyPoints?: boolean;

  @IsNumber()
  @IsOptional()
  deliveryLatitude?: number;

  @IsNumber()
  @IsOptional()
  deliveryLongitude?: number;

  // Multi-vendeurs (LIL-112)
  @IsBoolean()
  @IsOptional()
  isPreorder?: boolean;

  @IsDateString()
  @IsOptional()
  scheduledFor?: string; // ISO 8601
}
