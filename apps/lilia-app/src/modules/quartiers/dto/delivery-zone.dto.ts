import { IsArray, IsNotEmpty, IsNumber, IsOptional, IsString, Min } from 'class-validator';

export class CreateDeliveryZoneDto {
  @IsString()
  @IsNotEmpty()
  zoneName: string;

  @IsNumber()
  @Min(0)
  fee: number;

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  quartierIds?: string[];
}

export class UpdateDeliveryZoneDto {
  @IsString()
  @IsOptional()
  zoneName?: string;

  @IsNumber()
  @Min(0)
  @IsOptional()
  fee?: number;

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  quartierIds?: string[];
}

export class AddQuartiersToZoneDto {
  @IsArray()
  @IsString({ each: true })
  @IsNotEmpty()
  quartierIds: string[];
}
