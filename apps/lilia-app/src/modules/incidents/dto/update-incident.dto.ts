import { IncidentSeverity, IncidentStatus } from '@prisma/client';
import { IsEnum, IsOptional, IsString } from 'class-validator';

export class UpdateIncidentDto {
  @IsOptional()
  @IsEnum(IncidentStatus)
  status?: IncidentStatus;

  @IsOptional()
  @IsEnum(IncidentSeverity)
  severity?: IncidentSeverity;

  @IsOptional()
  @IsString()
  resolution?: string;
}
