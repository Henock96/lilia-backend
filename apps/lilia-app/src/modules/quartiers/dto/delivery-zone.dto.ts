import {
  IsArray,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';

export class CreateDeliveryZoneDto {
  @IsString()
  @IsNotEmpty()
  zoneName: string;

  @IsInt({
    message:
      'Un montant en francs CFA est un nombre entier — le XAF n’a pas de sous-unité.',
  })
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

  @IsInt({
    message:
      'Un montant en francs CFA est un nombre entier — le XAF n’a pas de sous-unité.',
  })
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
