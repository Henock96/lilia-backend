import { IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Corps de `POST /payments/:paymentId/reject` (fix M20).
 * `@Body('reason')` n'était ni validé ni borné, et la valeur est persistée
 * puis réaffichée dans l'admin.
 */
export class RejectPaymentDto {
  @IsOptional()
  @IsString()
  @MaxLength(300, { message: 'Le motif ne peut pas dépasser 300 caractères.' })
  reason?: string;
}
