import {
  IsDateString,
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { RefundStatus } from '@prisma/client';

import { DECLARED_CLOSURE_METHODS } from '../refund-closure-proof';

export class UpdateRefundStatusDto {
  @IsEnum(RefundStatus, {
    message: `status doit valoir : ${Object.values(RefundStatus).join(', ')}`,
  })
  status: RefundStatus;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;

  // ─── Preuve d'une clôture déclarée (audit du 28/10/2026, F-12) ──────────
  // Facultatifs au niveau du DTO : seule la clôture `COMPLETED` les exige, et
  // c'est le service qui le vérifie (`assertDeclaredClosureProof`), quel que
  // soit l'appelant — y compris l'exécution d'une approbation.

  @IsOptional()
  @IsIn(DECLARED_CLOSURE_METHODS, {
    message: `closureMethod doit valoir : ${DECLARED_CLOSURE_METHODS.join(', ')}`,
  })
  closureMethod?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  externalReference?: string;

  /** Date du remboursement hors prestataire (ISO 8601). */
  @IsOptional()
  @IsDateString()
  externalPaidAt?: string;
}
