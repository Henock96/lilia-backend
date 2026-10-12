import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import {
  SUBSCRIPTION_PAYMENT_METHODS,
  SubscriptionPaymentMethod,
} from '../plans';

/**
 * Enregistrer un mois d'abonnement **déjà payé** hors plateforme.
 *
 * Ni montant ni dates : le prix vient de `PlatformSettings`, la période est
 * calculée par le serveur (empilée à la suite de la période en cours).
 * L'administrateur n'atteste que le moyen de paiement et sa référence.
 */
export class GrantSubscriptionDto {
  @ApiProperty({ enum: SUBSCRIPTION_PAYMENT_METHODS })
  @IsIn(SUBSCRIPTION_PAYMENT_METHODS)
  paymentMethod: SubscriptionPaymentMethod;

  @ApiPropertyOptional({
    description: 'N° de transaction Mobile Money, de reçu…',
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  paymentReference?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class RevokeSubscriptionDto {
  @ApiProperty({ description: 'Motif, conservé dans la période et l’audit' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason: string;
}
