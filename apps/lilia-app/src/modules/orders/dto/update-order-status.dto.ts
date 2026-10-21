import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';
import { OrderStatus } from '@prisma/client';

export class UpdateOrderStatusDto {
  @IsEnum(OrderStatus)
  status: OrderStatus;

  /**
   * Lot 2 (ADM-09) — motif facultatif, pris en compte pour une annulation
   * seulement : repris dans l'historique et, pour l'ADMIN, au journal. Absent
   * (applications installées) : comportement d'avant.
   */
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MaxLength(200)
  reason?: string;
}
