import { Controller, Get, Post, Body, Param, UseGuards } from '@nestjs/common';
import { CategoriesService } from './categories.service';
import { CreateCategoryDto } from './dto/create-category.dto';
import { FirebaseAuthGuard } from 'src/firebase/firebase-auth.guard';
import { RolesGuard } from 'src/firebase/roles.guard';
import { Roles } from 'src/firebase/roles.decorator';

@Controller('categories')
// La protection par Guard est retirée de la classe pour être appliquée par méthode
export class CategoriesController {
  constructor(private readonly categoriesService: CategoriesService) {}

  @Post()
  @UseGuards(FirebaseAuthGuard, RolesGuard) // Protection spécifique à cette route
  @Roles('ADMIN')
  create(@Body() createCategoryDto: CreateCategoryDto) {
    return this.categoriesService.create(createCategoryDto);
  }

  @Get() // Pas de Guard, donc endpoint public
  findAll() {
    return this.categoriesService.findAll();
  }

  @Get(':id') // Pas de Guard, donc endpoint public
  findOne(@Param('id') id: string) {
    return this.categoriesService.findOne(id);
  }
}
