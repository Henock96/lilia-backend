import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
} from 'class-validator';

export class CreateVendorPhotoDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  restaurantId: string;

  @ApiProperty()
  @IsUrl()
  url: string;

  @ApiPropertyOptional({ description: 'Cloudinary public_id pour cleanup' })
  @IsOptional()
  @IsString()
  publicId?: string;

  @ApiPropertyOptional({ description: 'Texte alternatif (a11y + SEO), max 200 chars' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  alt?: string;

  @ApiPropertyOptional({ description: 'Marque cette photo comme cover (désactive les autres covers)' })
  @IsOptional()
  @IsBoolean()
  isCover?: boolean;
}
