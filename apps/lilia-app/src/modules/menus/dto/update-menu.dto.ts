import { ApiProperty, PartialType } from '@nestjs/swagger';
import { CreateMenuDto } from './create-menu.dto';

export class UpdateMenuDto extends PartialType(CreateMenuDto) {
  @ApiProperty({
    description: 'Nom du menu',
    example: 'Menu du Jour - Mercredi',
    required: false,
  })
  nom?: string;

  @ApiProperty({
    description: 'Description du menu',
    example: 'Notre menu spécial de la journée',
    required: false,
  })
  description?: string;

  @ApiProperty({
    description: "URL de l'image du menu",
    required: false,
  })
  imageUrl?: string;

  @ApiProperty({
    description: 'Prix du menu',
    example: 5000,
    required: false,
  })
  prix?: number;

  @ApiProperty({
    description: 'Date et heure de début de validité du menu',
    example: '2024-01-15T08:00:00Z',
    required: false,
  })
  dateDebut?: string;

  @ApiProperty({
    description: 'Date et heure de fin de validité du menu',
    example: '2024-01-15T20:00:00Z',
    required: false,
  })
  dateFin?: string;

  @ApiProperty({
    description: 'Statut actif du menu',
    required: false,
  })
  isActive?: boolean;

  @ApiProperty({
    description: 'Liste des produits à inclure dans le menu',
    required: false,
  })
  products?: Array<{ productId: string; ordre?: number }>;
}
