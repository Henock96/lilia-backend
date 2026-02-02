/* eslint-disable prettier/prettier */
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { CreateCategoryDto } from './dto/create-category.dto';
import { UpdateCategoryDto } from './dto/update-category.dto';

@Injectable()
export class CategoriesService {
  constructor(private prisma: PrismaService) {}

  async create(createCategoryDto: CreateCategoryDto) {
    // Vérifier si une catégorie avec ce nom existe déjà
    const existing = await this.prisma.category.findUnique({
      where: { nom: createCategoryDto.nom },
    });

    if (existing) {
      throw new BadRequestException('Une catégorie avec ce nom existe déjà.');
    }

    const category = await this.prisma.category.create({
      data: createCategoryDto,
    });

    return {
      data: category,
      message: 'Catégorie créée avec succès',
    };
  }

  async findAll(restaurantId?: string) {
    let categories;

    if (restaurantId) {
      // Filtrer les catégories qui ont au moins un produit dans ce restaurant
      categories = await this.prisma.category.findMany({
        where: {
          products: {
            some: {
              restaurantId: restaurantId,
            },
          },
        },
        orderBy: { nom: 'asc' },
        include: {
          _count: {
            select: {
              products: {
                where: {
                  restaurantId: restaurantId,
                },
              },
            },
          },
        },
      });
    } else {
      // Retourner toutes les catégories
      categories = await this.prisma.category.findMany({
        orderBy: { nom: 'asc' },
        include: {
          _count: {
            select: { products: true },
          },
        },
      });
    }

    return {
      data: categories,
      count: categories.length,
    };
  }

  async findOne(id: string) {
    const category = await this.prisma.category.findUnique({
      where: { id },
      include: {
        products: {
          include: {
            variants: true,
            restaurant: {
              select: { id: true, nom: true },
            },
          },
        },
      },
    });

    if (!category) {
      throw new NotFoundException(`Catégorie avec l'ID "${id}" non trouvée.`);
    }

    return {
      data: category,
    };
  }

  async update(id: string, updateCategoryDto: UpdateCategoryDto) {
    // Vérifier que la catégorie existe
    const category = await this.prisma.category.findUnique({
      where: { id },
    });

    if (!category) {
      throw new NotFoundException(`Catégorie avec l'ID "${id}" non trouvée.`);
    }

    // Vérifier si le nouveau nom est déjà utilisé par une autre catégorie
    if (updateCategoryDto.nom !== category.nom) {
      const existing = await this.prisma.category.findUnique({
        where: { nom: updateCategoryDto.nom },
      });

      if (existing) {
        throw new BadRequestException('Une catégorie avec ce nom existe déjà.');
      }
    }

    const updated = await this.prisma.category.update({
      where: { id },
      data: updateCategoryDto,
    });

    return {
      data: updated,
      message: 'Catégorie mise à jour avec succès',
    };
  }

  async remove(id: string) {
    // Vérifier que la catégorie existe
    const category = await this.prisma.category.findUnique({
      where: { id },
      include: {
        _count: {
          select: { products: true },
        },
      },
    });

    if (!category) {
      throw new NotFoundException(`Catégorie avec l'ID "${id}" non trouvée.`);
    }

    // Vérifier si des produits utilisent cette catégorie
    if (category._count.products > 0) {
      throw new BadRequestException(
        `Impossible de supprimer cette catégorie car ${category._count.products} produit(s) l'utilisent. Veuillez d'abord réassigner ou supprimer ces produits.`,
      );
    }

    await this.prisma.category.delete({
      where: { id },
    });

    return {
      message: 'Catégorie supprimée avec succès',
    };
  }
}