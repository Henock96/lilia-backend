import { IsInt, Min } from 'class-validator';

export class ReorderBannerDto {
  @IsInt()
  @Min(0)
  displayOrder: number;
}
