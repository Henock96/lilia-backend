import { MAX_ITEM_QUANTITY } from './add-to-cart.dto';
import { IsInt, IsNotEmpty, IsString, Max, Min } from 'class-validator';

export class AddMenuToCartDto {
  @IsString()
  @IsNotEmpty()
  menuId: string;

  @IsInt()
  @Min(1)
  @Max(MAX_ITEM_QUANTITY, {
    message: `Quantité maximale : ${MAX_ITEM_QUANTITY} par article`,
  })
  quantite: number;
}
