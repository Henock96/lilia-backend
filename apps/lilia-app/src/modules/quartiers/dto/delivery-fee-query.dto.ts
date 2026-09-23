import { Transform } from 'class-transformer';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

/**
 * Paramètres de `GET /quartiers/delivery-fee` (route publique).
 *
 * Les deux identifiants arrivaient en `@Query` bruts : un paramètre absent
 * descendait jusqu'à Prisma au lieu d'être refusé à l'entrée.
 */
export class DeliveryFeeQueryDto {
  @Transform(trim)
  @IsString()
  @IsNotEmpty({ message: 'restaurantId est obligatoire.' })
  @MaxLength(64)
  restaurantId: string;

  @Transform(trim)
  @IsString()
  @IsNotEmpty({ message: 'quartierId est obligatoire.' })
  @MaxLength(64)
  quartierId: string;
}
