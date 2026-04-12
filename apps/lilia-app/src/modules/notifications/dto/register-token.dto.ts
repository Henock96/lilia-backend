import { IsNotEmpty, IsString } from 'class-validator';

export class RegisterTokenDto {
  @IsString()
  @IsNotEmpty()
  token: string;
}
