import { IsString, IsNotEmpty, IsEnum, IsOptional, IsBoolean } from 'class-validator';
import { PaymentMethod } from '@prisma/client';
import { Transform } from 'class-transformer';

export class CreateOrderDto {
  @IsString()
  @IsOptional()
  adresseId?: string; // Optionnel car pas nécessaire pour le retrait

  @IsEnum(PaymentMethod)
  @IsNotEmpty()
  paymentMethod: PaymentMethod;

  @IsString()
  @IsOptional()
  notes?: string;

  @IsBoolean()
  @IsOptional()
  @Transform(({ value }) => value ?? true) // Par défaut: livraison
  isDelivery?: boolean = true;
}
