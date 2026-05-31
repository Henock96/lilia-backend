import {
  Controller,
  Post,
  Body,
  Get,
  Query,
  Param,
  Patch,
  Delete,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { DecodedIdToken } from 'firebase-admin/auth';
import { ProductType, VendorType } from '@prisma/client';
import { ProductsService } from './products.service';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { FirebaseUser } from '../auth/decorators/firebase-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { Public } from '../auth/decorators/public.decorator';

@ApiTags('Products')
@ApiBearerAuth()
@Controller('products')
export class ProductsController {
  constructor(private readonly productsService: ProductsService) {}

  /**
   * GET /products
   * Récupère tous les produits avec filtres optionnels
   * Paramètres: restaurantId, categoryId, page, limit
   */
  // ─── Publiques (avant :id) ─────────────────────────────────────────────────

  @Public()
  @Get()
  @ApiOperation({ summary: 'Catalogue marketplace (vendeurs approuvés + actifs)' })
  @ApiQuery({ name: 'restaurantId', required: false })
  @ApiQuery({ name: 'categoryId', required: false })
  @ApiQuery({ name: 'productType', required: false, enum: ProductType })
  @ApiQuery({ name: 'vendorType', required: false, enum: VendorType })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  findAll(
    @Query('restaurantId') restaurantId?: string,
    @Query('categoryId') categoryId?: string,
    @Query('page') page = '1',
    @Query('limit') limit = '20',
    @Query('productType') productType?: ProductType,
    @Query('vendorType') vendorType?: VendorType,
  ) {
    return this.productsService.findAll(
      restaurantId,
      categoryId,
      parseInt(page, 10),
      parseInt(limit, 10),
      productType,
      vendorType,
    );
  }

  /**
   * GET /products/search?q=...
   * Recherche de produits et restaurants
   */
  @Public()
  @Get('search')
  @ApiOperation({ summary: 'Recherche produits + restaurants' })
  search(@Query('q') q = '', @Query('limit') limit = '20') {
    return this.productsService.search(q, parseInt(limit, 10));
  }

  /**
   * GET /products/popular?limit=10
   * Récupère les plats les plus commandés
   */
  @Public()
  @Get('popular')
  @ApiOperation({ summary: 'Plats les plus commandés' })
  findPopular(@Query('limit') limit = '10') {
    return this.productsService.findPopular(parseInt(limit, 10));
  }

  /**
   * GET /products/recommendations
   * Recommandations basées sur l'historique de l'utilisateur (authentifié)
   */
  @Get('recommendations')
  @ApiOperation({ summary: 'Recommandations personnalisées (authentifié)' })
  getRecommendations(
    @FirebaseUser() fbUser: DecodedIdToken,
    @Query('limit') limit = '10',
  ) {
    return this.productsService.getRecommendations(
      fbUser.uid,
      parseInt(limit, 10),
    );
  }

  /**
   * GET /products/:id
   * Récupère un produit par son ID
   */
  @Public()
  @Get(':id')
  @ApiOperation({ summary: 'Un produit par ID' })
  findOne(@Param('id') id: string) {
    return this.productsService.findOne(id);
  }
  // ─── Protégées ─────────────────────────────────────────────────────────────

  /**
   * POST /products
   * Crée un nouveau produit
   */
  @Post()
  @Roles('RESTAURATEUR', 'ADMIN')
  @ApiOperation({ summary: 'Créer un produit' })
  create(
    @Body() dto: CreateProductDto,
    @FirebaseUser() fbUser: DecodedIdToken,
  ) {
    return this.productsService.create(dto, fbUser.uid);
  }

  /**
   * PATCH /products/:id
   * Met à jour un produit existant
   */
  @Patch(':id')
  @Roles('RESTAURATEUR', 'ADMIN')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Modifier un produit' })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateProductDto,
    @FirebaseUser() fbUser: DecodedIdToken,
  ) {
    return this.productsService.update(id, dto, fbUser.uid);
  }

  /**
   * PATCH /products/:id/stock
   * Met à jour le stock d'un produit
   */
  @Patch(':id/stock')
  @Roles('RESTAURATEUR', 'ADMIN')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mettre à jour le stock' })
  updateStock(
    @Param('id') id: string,
    @Body('stockQuotidien') stockQuotidien: number | null,
    @FirebaseUser() fbUser: DecodedIdToken,
  ) {
    return this.productsService.updateStock(id, stockQuotidien, fbUser.uid);
  }

  /**
   * DELETE /products/:id
   * Supprime un produit
   */
  @Delete(':id')
  @Roles('RESTAURATEUR', 'ADMIN')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Supprimer un produit' })
  remove(@Param('id') id: string, @FirebaseUser() fbUser: DecodedIdToken) {
    return this.productsService.remove(id, fbUser.uid);
  }
}
