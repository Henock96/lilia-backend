/* eslint-disable prettier/prettier */
import { IsOptional, IsString } from 'class-validator';

export class BanUserDto {
  @IsOptional()
  @IsString()
  reason?: string;
}