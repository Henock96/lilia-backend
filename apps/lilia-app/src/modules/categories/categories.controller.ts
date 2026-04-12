// categories/categories.controller.ts
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';

import { CategoriesService } from './categories.service';
import { CreateCategoryDto } from './dto/create-category.dto';
import { UpdateCategoryDto } from './dto/update-category.dto';
import { Roles } from '../auth/decorators/roles.decorator';
import { Public } from '../auth/decorators/public.decorator';

@ApiTags('Categories')
@ApiBearerAuth()
@Controller('categories')
export class CategoriesController {
  constructor(private readonly categoriesService: CategoriesService) {}

  @Public()
  @Get()
  @ApiOperation({ summary: 'Toutes les catégories, filtrables par restaurant' })
  @ApiQuery({ name: 'restaurantId', required: false })
  findAll(@Query('restaurantId') restaurantId?: string) {
    return this.categoriesService.findAll(restaurantId);
  }

  @Public()
  @Get(':id')
  @ApiOperation({ summary: 'Une catégorie avec ses produits' })
  findOne(@Param('id') id: string) {
    return this.categoriesService.findOne(id);
  }

  @Post()
  @Roles('RESTAURATEUR', 'ADMIN')
  @ApiOperation({ summary: 'Créer une catégorie' })
  create(@Body() dto: CreateCategoryDto) {
    return this.categoriesService.create(dto);
  }

  @Patch(':id')
  @Roles('RESTAURATEUR', 'ADMIN')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Modifier une catégorie' })
  update(@Param('id') id: string, @Body() dto: UpdateCategoryDto) {
    return this.categoriesService.update(id, dto);
  }

  @Delete(':id')
  @Roles('ADMIN')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Supprimer une catégorie (admin, aucun produit lié)',
  })
  remove(@Param('id') id: string) {
    return this.categoriesService.remove(id);
  }
}
