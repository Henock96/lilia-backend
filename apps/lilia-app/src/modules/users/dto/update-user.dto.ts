/* eslint-disable prettier/prettier */
import { IsOptional, IsString, IsUrl } from 'class-validator';

export class UpdateUserDto {
  @IsOptional()
  @IsString()
  nom?: string;

  @IsOptional()
  @IsString()
  phone?: string;

  @IsOptional()
  @IsUrl({}, { message: 'L\'URL de l\'image doit être une URL valide.' })
  imageUrl?: string;
}
