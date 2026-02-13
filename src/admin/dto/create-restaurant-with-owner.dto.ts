import { IsEmail, IsNotEmpty, IsOptional, IsString, MinLength } from 'class-validator';

export class CreateRestaurantWithOwnerDto {
  // User fields
  @IsEmail()
  @IsNotEmpty()
  email: string;

  @IsString()
  @IsNotEmpty()
  @MinLength(6)
  password: string;

  @IsString()
  @IsNotEmpty()
  nom: string;

  @IsString()
  @IsOptional()
  phone?: string;

  // Restaurant fields
  @IsString()
  @IsNotEmpty()
  restaurantNom: string;

  @IsString()
  @IsNotEmpty()
  restaurantAdresse: string;

  @IsString()
  @IsNotEmpty()
  restaurantPhone: string;

  @IsString()
  @IsOptional()
  restaurantImageUrl?: string;
}
