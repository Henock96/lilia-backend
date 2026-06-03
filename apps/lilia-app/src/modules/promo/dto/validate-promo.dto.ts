import { IsNotEmpty, IsNumber, IsString, Min } from 'class-validator';

export class ValidatePromoDto {
  @IsString()
  @IsNotEmpty()
  code: string;

  @IsString()
  @IsNotEmpty()
  restaurantId: string;

  // Min(0) : empêche un subTotal négatif qui contournerait minOrderAmount /
  // produirait une réduction incohérente.
  @IsNumber()
  @Min(0)
  subTotal: number;

  @IsNumber()
  @Min(0)
  deliveryFee: number;
}
