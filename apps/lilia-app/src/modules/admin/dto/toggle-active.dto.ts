/* eslint-disable prettier/prettier */
import { IsBoolean } from 'class-validator';

export class ToggleActiveDto {
  @IsBoolean()
  isActive: boolean;
}