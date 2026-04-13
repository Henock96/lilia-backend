// promo/dto/create-promo-code.dto.ts
import {
  IsBoolean, IsDateString, IsEnum, IsInt,
  IsNumber, IsOptional, IsString, Max, MaxLength, Min, MinLength,
} from 'class-validator';

export enum DiscountType {
  FIXED = 'FIXED',
  PERCENT = 'PERCENT',
  FREE_DELIVERY = 'FREE_DELIVERY',
}

export class CreatePromoCodeDto {
  @IsString()
  @MinLength(3)
  @MaxLength(20)
  code: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsEnum(DiscountType)
  discountType: DiscountType;

  @IsNumber()
  @Min(0)
  discountValue: number;            // 500 si FIXED, 10 si PERCENT

  @IsOptional()
  @IsNumber()
  maxDiscount?: number;             // plafond si PERCENT

  @IsOptional()
  @IsNumber()
  @Min(0)
  minOrderAmount?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  maxUsageTotal?: number;           // null = illimité

  @IsOptional()
  @IsInt()
  @Min(1)
  maxUsagePerUser?: number;

  @IsOptional()
  @IsBoolean()
  firstOrderOnly?: boolean;

  @IsOptional()
  @IsString()
  restaurantId?: string;            // null = toute la plateforme

  @IsOptional()
  @IsDateString()
  startsAt?: string;

  @IsOptional()
  @IsDateString()
  expiresAt?: string;
}