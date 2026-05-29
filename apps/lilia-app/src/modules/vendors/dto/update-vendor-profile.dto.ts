/* eslint-disable prettier/prettier */
import { IsArray, IsOptional, IsString, MaxLength } from 'class-validator';

export class UpdateVendorProfileDto {
  @IsString()
  @IsOptional()
  @MaxLength(2000)
  story?: string;

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  certifications?: string[];

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  specialties?: string[];

  @IsString()
  @IsOptional()
  @MaxLength(500)
  productionNote?: string;
}
