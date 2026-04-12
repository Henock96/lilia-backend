/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import {
  IsString,
  IsNumber,
  IsOptional,
  IsArray,
  IsDateString,
  IsBoolean,
  IsEnum,
  ValidateNested,
  ValidateIf,
  ArrayMinSize,
} from 'class-validator';
import { Type } from 'class-transformer';
import { MenuType } from '@prisma/client';

export class MenuProductDto {
  @ApiProperty({ description: 'ID du produit à inclure dans le menu' })
  @IsString()
  productId: string;

  @ApiProperty({
    description: "Ordre d'affichage du produit dans le menu",
    required: false,
    default: 0,
  })
  @IsOptional()
  @IsNumber()
  ordre?: number;
}

export class CreateMenuDto {
  @ApiProperty({
    description: 'Nom du menu',
    example: 'Menu du Jour - Mercredi',
  })
  @IsString()
  nom: string;

  @ApiProperty({
    description: 'Description du menu',
    example: 'Notre menu spécial de la journée',
    required: false,
  })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({
    description: 'URL de l\'image du menu',
    required: false,
  })
  @IsOptional()
  @IsString()
  imageUrl?: string;

  @ApiProperty({
    description: 'Prix du menu',
    example: 5000,
  })
  @IsNumber()
  prix: number;

  @ApiProperty({
    description: 'Type de menu: COMBO (multi-produits) ou PLAT_SPECIAL (plat unique)',
    enum: MenuType,
    default: 'COMBO',
    required: false,
  })
  @IsOptional()
  @IsEnum(MenuType)
  type?: MenuType;

  @ApiProperty({
    description: 'Composition du plat special (texte libre). Utilise uniquement pour PLAT_SPECIAL.',
    example: 'Riz, poulet grille, legumes sautes, sauce tomate',
    required: false,
  })
  @IsOptional()
  @IsString()
  ingredients?: string;

  @ApiProperty({
    description: 'Date et heure de début de validité du menu',
    example: '2024-01-15T08:00:00Z',
  })
  @IsDateString()
  dateDebut: string;

  @ApiProperty({
    description: 'Date et heure de fin de validité du menu',
    example: '2024-01-15T20:00:00Z',
  })
  @IsDateString()
  dateFin: string;

  @ApiProperty({
    description: 'Statut actif du menu',
    default: true,
    required: false,
  })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiProperty({
    description: 'Liste des produits à inclure dans le menu (requis pour COMBO, ignore pour PLAT_SPECIAL)',
    type: [MenuProductDto],
    required: false,
  })
  @IsOptional()
  @ValidateIf((o) => o.type !== 'PLAT_SPECIAL')
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => MenuProductDto)
  products?: MenuProductDto[];
}
