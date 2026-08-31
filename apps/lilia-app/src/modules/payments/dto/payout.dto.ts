import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { PayoutProvider, PayoutStatus } from '@prisma/client';

/**
 * Corps de `POST /admin/orders/:orderId/payout`.
 *
 * ⚠️ **Aucun montant.** Le décompte est intégralement recalculé côté serveur à
 * partir du sous-total de la commande et du taux en vigueur. Accepter un montant
 * ici — même « pour information » — en ferait un jour la source de vérité par
 * inadvertance, exactement comme le champ `amount` qui traînait dans
 * `CreatePaymentDto` jusqu'à son retrait.
 *
 * Le seul champ utile est une note d'administration, qui atterrit dans le
 * journal d'audit.
 */
export class RequestPayoutDto {
  @ApiPropertyOptional({
    description: "Note libre, tracée dans le journal d'audit",
  })
  @IsOptional()
  @IsString()
  @MaxLength(300, { message: 'La note ne peut pas dépasser 300 caractères.' })
  note?: string;
}

/** Filtres de `GET /admin/payouts`. */
export class ListPayoutsQueryDto {
  @ApiPropertyOptional({ enum: PayoutStatus })
  @IsOptional()
  @IsEnum(PayoutStatus, { message: 'Statut de reversement inconnu.' })
  status?: PayoutStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(64)
  restaurantId?: string;

  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsOptional()
  page: number = 1;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 20 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  @IsOptional()
  limit: number = 20;
}

/**
 * Coordonnées Mobile Money de reversement d'un vendeur.
 *
 * Réservé à l'ADMIN. Un vendeur qui pourrait modifier lui-même le numéro sur
 * lequel il est payé pourrait aussi le faire modifier par quelqu'un qui aurait
 * pris la main sur son compte — et l'argent partirait ailleurs sans qu'aucune
 * alerte ne se déclenche. Même raisonnement que pour `commissionPercent`, qui
 * n'est pas non plus dans `UpdateRestaurantDto`.
 */
export class UpdatePayoutAccountDto {
  /**
   * MSISDN ou numéro local congolais. Le format canonique (chiffres, indicatif
   * inclus) est appliqué côté service — on accepte ici les deux écritures pour
   * ne pas piéger l'administrateur sur un espace ou un zéro initial.
   */
  @IsString()
  @Matches(/^(\+?242)?0?[456]\d{7}$/, {
    message:
      'Numéro Mobile Money congolais invalide (ex. 06 123 45 67 ou 242061234567).',
  })
  payoutPhoneNumber!: string;

  @IsEnum(PayoutProvider, {
    message: 'Opérateur de reversement invalide (MTN_MOMO ou AIRTEL_MONEY).',
  })
  payoutProvider!: PayoutProvider;

  /**
   * Titulaire du compte, pour le contrôle humain avant envoi. Purement
   * informatif : jamais transmis au prestataire, qui n'accepte pas de
   * vérification de nom sur ce marché.
   */
  @IsOptional()
  @IsString()
  @MaxLength(120)
  payoutAccountName?: string;
}
