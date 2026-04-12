import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
} from 'class-validator';

export class UpdateBannerDto {
  @IsString()
  @IsOptional()
  title?: string;

  @IsUrl()
  @IsOptional()
  imageUrl?: string;

  @IsString()
  @IsOptional()
  description?: string;

  @IsString()
  @IsOptional()
  linkUrl?: string;

  @IsBoolean()
  @IsOptional()
  isActive?: boolean;

  @IsInt()
  @IsOptional()
  displayOrder?: number;
}
