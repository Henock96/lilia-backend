import { IsEnum, IsInt, IsOptional, Min } from 'class-validator';

export class TriggerBackfillDto {
  @IsEnum(['orders', 'restaurants', 'incidents'])
  entity!: 'orders' | 'restaurants' | 'incidents';

  @IsOptional()
  @IsInt()
  @Min(1)
  limit?: number;
}
