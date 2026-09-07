import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  NotEquals,
} from 'class-validator';
import { ReferralRewardStatus } from '@prisma/client';

import { PaginationQueryDto } from '../../../common/pagination/pagination-query.dto';

/**
 * Ajustement manuel d'un solde de fidélité.
 *
 * Le motif est **obligatoire** et longuement borné : c'est la seule chose qui
 * rendra l'écriture compréhensible dans six mois, et un champ facultatif reste
 * vide dans 90 % des cas.
 */
export class AdjustLoyaltyDto {
  /** Positif = crédit, négatif = débit. Jamais 0. */
  @IsInt()
  @NotEquals(0)
  points: number;

  @IsString()
  @IsNotEmpty()
  @MinLength(5)
  @MaxLength(300)
  reason: string;
}

export class ReviewReferralRewardDto {
  @IsIn(['APPROVE', 'REJECT'])
  decision: 'APPROVE' | 'REJECT';

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class ReferralRewardFilterDto extends PaginationQueryDto {
  @IsOptional()
  @IsIn(Object.values(ReferralRewardStatus))
  status?: ReferralRewardStatus;
}
