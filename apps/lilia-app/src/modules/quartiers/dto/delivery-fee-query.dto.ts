import { Transform, Type } from 'class-transformer';
import {
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

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

  /**
   * Sous-total du panier, en XAF (F3-02). Sert uniquement au seuil
   * « livraison offerte dès X » du vendeur ; absent, le devis est au prix
   * plein. Ce n'est qu'une estimation : le checkout recalcule sur le panier
   * serveur, jamais sur ce paramètre.
   */
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'subTotal doit être un entier (XAF).' })
  @Min(0)
  @Max(10_000_000)
  subTotal?: number;
}
