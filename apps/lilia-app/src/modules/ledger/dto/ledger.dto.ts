import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

import { RECONCILIATION_TYPES } from '../reconciliation-rules';
import {
  MAX_IMPORT_ROWS,
  MIN_RESOLUTION_NOTE,
  RESOLUTION_KINDS,
} from '../reconciliation.service';

/** Ligne d'export prestataire, déjà normalisée (format pawaPay non figé). */
export class ProviderRowDto {
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  externalId!: string;

  @IsIn(['DEPOSIT', 'PAYOUT'])
  kind!: 'DEPOSIT' | 'PAYOUT';

  @IsString()
  @MaxLength(32)
  status!: string;

  @IsInt({ message: 'Montant en entier XAF.' })
  @Min(0)
  amountXaf!: number;

  @IsString()
  @MaxLength(3)
  currency!: string;

  @IsOptional()
  @IsInt({ message: 'Frais en entier XAF.' })
  @Min(0)
  feeXaf?: number | null;
}

export class ImportReconciliationDto {
  @IsDateString()
  periodStart!: string;

  @IsDateString()
  periodEnd!: string;

  /** Solde du wallet à la fin de la période, lu au tableau de bord. */
  @IsOptional()
  @IsInt({ message: 'Solde en entier XAF.' })
  walletBalanceXaf?: number | null;

  @IsArray()
  @ArrayMaxSize(MAX_IMPORT_ROWS)
  @ValidateNested({ each: true })
  @Type(() => ProviderRowDto)
  rows!: ProviderRowDto[];
}

export class ResolveReconciliationItemDto {
  @IsIn(RESOLUTION_KINDS as unknown as string[])
  kind!: (typeof RESOLUTION_KINDS)[number];

  @IsString()
  @MinLength(MIN_RESOLUTION_NOTE, {
    message: `Motif obligatoire (${MIN_RESOLUTION_NOTE} caractères au moins).`,
  })
  @MaxLength(2000)
  note!: string;
}

export class ReconciliationNoteDto {
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  note!: string;
}

export class ListReconciliationItemsQueryDto {
  @IsOptional()
  @IsIn(['OPEN', 'RESOLVED'])
  status?: 'OPEN' | 'RESOLVED';

  @IsOptional()
  @IsIn(RECONCILIATION_TYPES as unknown as string[])
  type?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  restaurantId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  cursor?: string;
}

export class ReverseLedgerTransactionDto {
  @IsString()
  @MinLength(10, { message: 'Motif obligatoire (10 caractères au moins).' })
  @MaxLength(2000)
  reason!: string;
}

export class ExcludeOrderDto {
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  orderId!: string;

  @IsString()
  @MinLength(10, { message: 'Motif obligatoire (10 caractères au moins).' })
  @MaxLength(500)
  reason!: string;
}

export class LedgerCatchUpDto {
  /**
   * Les faits antérieurs à cette date sont écrits `BACKFILL` (reprise de
   * l'historique) ; les suivants `LIVE`.
   */
  @IsOptional()
  @IsDateString()
  backfillBefore?: string;
}

export class ResolvePostingExceptionDto {
  @IsString()
  @MinLength(10, { message: 'Motif obligatoire (10 caractères au moins).' })
  @MaxLength(2000)
  note!: string;
}
