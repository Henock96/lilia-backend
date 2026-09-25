import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { RefundBearer, RefundLineKind } from '@prisma/client';

import {
  MANUAL_REFUND_REASON_CODES,
  type ManualRefundReasonCode,
} from '../refund-lines.policy';
import { MAX_AMOUNT_XAF } from '../../payments/money.util';

/**
 * Une ligne demandée au composeur (F3-06). Le montant d'une ligne `ITEM`
 * n'est **jamais** lu ici : il vient du prix figé sur la commande.
 */
export class RefundLineInputDto {
  @IsEnum(RefundLineKind)
  kind: RefundLineKind;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  orderItemId?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1000)
  quantity?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_AMOUNT_XAF)
  amountXaf?: number;
}

export class ComposeRefundDto {
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => RefundLineInputDto)
  lines: RefundLineInputDto[];

  /** Les motifs « automatiques » (annulation, échec…) ne se composent pas. */
  @IsIn(MANUAL_REFUND_REASON_CODES)
  reasonCode: ManualRefundReasonCode;

  /** Absent = payeur par défaut du motif (R-06.4). */
  @IsOptional()
  @IsEnum(RefundBearer)
  bearer?: RefundBearer;

  /** Réclamation à l'origine du remboursement. */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  incidentId?: string;

  /** Note interne, et message au client si la réclamation est clôturée. */
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;

  /** Virer tout de suite (défaut : oui). Non = laisser en file. */
  @IsOptional()
  @IsBoolean()
  execute?: boolean;
}
