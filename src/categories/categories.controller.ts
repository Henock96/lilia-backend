import { Controller, Get, Post, Body, Param, UseGuards, Patch, Delete, Query } from '@nestjs/common';
import { CategoriesService } from './categories.service';
import { CreateCategoryDto } from './dto/create-category.dto';
import { UpdateCategoryDto } from './dto/update-category.dto';
import { FirebaseAuthGuard } from 'src/firebase/firebase-auth.guard';
import { RolesGuard } from 'src/firebase/roles.guard';
import { Roles } from 'src/firebase/roles.decorator';

@Controller('categories')
export class CategoriesController {
  constructor(private readonly categoriesService: CategoriesService) {}

  /**
   * POST /categories
   * Crée une nouvelle catégorie
   */
  @Post()
  @UseGuards(FirebaseAuthGuard, RolesGuard)
  @Roles('RESTAURATEUR', 'ADMIN')
  create(@Body() createCategoryDto: CreateCategoryDto) {
    return this.categoriesService.create(createCategoryDto);
  }

  /**
   * GET /categories
   * Récupère toutes les catégories
   * Optionnel: filtrer par restaurantId pour n'avoir que les catégories utilisées
   */
  @Get()
  findAll(@Query('restaurantId') restaurantId?: string) {
    return this.categoriesService.findAll(restaurantId);
  }

  /**
   * GET /categories/:id
   * Récupère une catégorie par son ID avec ses produits
   */
  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.categoriesService.findOne(id);
  }

  /**
   * PATCH /categories/:id
   * Met à jour une catégorie
   */
  @Patch(':id')
  @UseGuards(FirebaseAuthGuard, RolesGuard)
  @Roles('RESTAURATEUR', 'ADMIN')
  update(@Param('id') id: string, @Body() updateCategoryDto: UpdateCategoryDto) {
    return this.categoriesService.update(id, updateCategoryDto);
  }

  /**
   * DELETE /categories/:id
   * Supprime une catégorie (seulement si aucun produit ne l'utilise)
   */
  @Delete(':id')
  @UseGuards(FirebaseAuthGuard, RolesGuard)
  @Roles('ADMIN')
  remove(@Param('id') id: string) {
    return this.categoriesService.remove(id);
  }
}
