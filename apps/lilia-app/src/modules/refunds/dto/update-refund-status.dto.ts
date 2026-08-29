import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { RefundStatus } from '@prisma/client';

export class UpdateRefundStatusDto {
  @IsEnum(RefundStatus, {
    message: `status doit valoir : ${Object.values(RefundStatus).join(', ')}`,
  })
  status: RefundStatus;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}
