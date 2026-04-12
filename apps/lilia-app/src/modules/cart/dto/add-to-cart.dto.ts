import { IsInt, IsNotEmpty, IsString, Min } from 'class-validator';

export class AddToCartDto {
  @IsString()
  @IsNotEmpty()
  variantId: string;

  @IsInt()
  @Min(1)
  quantite: number;
}
