import { IsInt, IsNotEmpty, IsString, Min } from 'class-validator';

export class AddMenuToCartDto {
  @IsString()
  @IsNotEmpty()
  menuId: string;

  @IsInt()
  @Min(1)
  quantite: number;
}
