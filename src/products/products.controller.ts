import {
  Controller,
  Post,
  Body,
  UseGuards,
  Req,
  Get,
  Query,
  Param,
  Patch,
  Delete,
} from '@nestjs/common';
import { ProductsService } from './products.service';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { FirebaseAuthGuard } from 'src/firebase/firebase-auth.guard';
import { RolesGuard } from 'src/firebase/roles.guard';
import { Roles } from 'src/firebase/roles.decorator';

@Controller('products')
export class ProductsController {
  constructor(private readonly productsService: ProductsService) {}

  /**
   * GET /products
   * Récupère tous les produits avec filtres optionnels
   * Paramètres: restaurantId, categoryId, page, limit
   */
  @Get()
  findAll(
    @Query('restaurantId') restaurantId?: string,
    @Query('categoryId') categoryId?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.productsService.findAll(
      restaurantId,
      categoryId,
      page ? parseInt(page, 10) : 1,
      limit ? parseInt(limit, 10) : 20,
    );
  }

  /**
   * GET /products/:id
   * Récupère un produit par son ID
   */
  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.productsService.findOne(id);
  }

  /**
   * POST /products
   * Crée un nouveau produit
   */
  @Post()
  @UseGuards(FirebaseAuthGuard, RolesGuard)
  @Roles('RESTAURATEUR', 'ADMIN')
  create(@Body() createProductDto: CreateProductDto, @Req() req) {
    return this.productsService.create(createProductDto, req.user.uid);
  }

  /**
   * PATCH /products/:id
   * Met à jour un produit existant
   */
  @Patch(':id')
  @UseGuards(FirebaseAuthGuard, RolesGuard)
  @Roles('RESTAURATEUR', 'ADMIN')
  update(
    @Param('id') id: string,
    @Body() updateProductDto: UpdateProductDto,
    @Req() req,
  ) {
    return this.productsService.update(id, updateProductDto, req.user.uid);
  }

  /**
   * PATCH /products/:id/stock
   * Met à jour le stock d'un produit
   */
  @Patch(':id/stock')
  @UseGuards(FirebaseAuthGuard, RolesGuard)
  @Roles('RESTAURATEUR', 'ADMIN')
  updateStock(
    @Param('id') id: string,
    @Body('stockQuotidien') stockQuotidien: number | null,
    @Req() req,
  ) {
    return this.productsService.updateStock(id, stockQuotidien, req.user.uid);
  }

  /**
   * DELETE /products/:id
   * Supprime un produit
   */
  @Delete(':id')
  @UseGuards(FirebaseAuthGuard, RolesGuard)
  @Roles('RESTAURATEUR', 'ADMIN')
  remove(@Param('id') id: string, @Req() req) {
    return this.productsService.remove(id, req.user.uid);
  }
}
