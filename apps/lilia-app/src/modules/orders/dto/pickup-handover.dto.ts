import { ApiProperty } from '@nestjs/swagger';
import { Matches } from 'class-validator';

/** `POST /orders/:id/pickup/handover` — F3-07, code de retrait (D-P5). */
export class PickupHandoverDto {
  @ApiProperty({
    example: '4821',
    description: 'Code à 4 chiffres montré par le client au comptoir.',
  })
  @Matches(/^\d{4}$/, { message: 'Le code de retrait compte 4 chiffres.' })
  code!: string;
}
