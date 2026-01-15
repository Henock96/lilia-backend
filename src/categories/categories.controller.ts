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
  @Roles('RESTAURATEUR', 'ADMIN')
  create(@Body() createCategoryDto: CreateCategoryDto) {
    return this.categoriesService.create(createCategoryDto);
  }
  /*
 g -> cmd9ipbiz0000o4hjmcbgl7ia
 a -> cmd9is39o0001o4hj3enz97ow
 b -> cmd9itwbi0002o4hjr7vflgfz
*/
  @Get() // Pas de Guard, donc endpoint public
  findAll() {
    return this.categoriesService.findAll();
  }

  @Get(':id') // Pas de Guard, donc endpoint public
  findOne(@Param('id') id: string) {
    return this.categoriesService.findOne(id);
  }
}
