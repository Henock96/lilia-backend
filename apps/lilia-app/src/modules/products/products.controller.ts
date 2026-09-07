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
import { ReorderProductsDto } from './dto/reorder-products.dto';
import { UpdateProductStockDto } from './dto/update-product-stock.dto';
import {
  ProductFilterQueryDto,
  ProductSearchQueryDto,
} from './dto/product-query.dto';
import { PaginationQueryDto } from '../../common/pagination/pagination-query.dto';
import { FirebaseUser } from '../auth/decorators/firebase-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { UpdateAvailabilityDto } from './dto/update-availability.dto';

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
  @ApiOperation({
    summary: 'Catalogue marketplace (vendeurs approuvés + actifs)',
  })
  @ApiQuery({ name: 'restaurantId', required: false })
  @ApiQuery({ name: 'categoryId', required: false })
  @ApiQuery({ name: 'productType', required: false, enum: ProductType })
  @ApiQuery({ name: 'vendorType', required: false, enum: VendorType })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  findAll(@Query() query: ProductFilterQueryDto) {
    return this.productsService.findAll(
      query.restaurantId,
      query.categoryId,
      query.page,
      query.limit,
      query.productType,
      query.vendorType,
    );
  }

  /**
   * GET /products/search?q=...
   * Recherche de produits et restaurants
   */
  @Public()
  @Get('search')
  @ApiOperation({ summary: 'Recherche produits + restaurants' })
  search(@Query() query: ProductSearchQueryDto) {
    return this.productsService.search(query.q, query.limit);
  }

  /**
   * GET /products/popular?limit=10
   * Récupère les plats les plus commandés
   */
  @Public()
  @Get('popular')
  @ApiOperation({ summary: 'Plats les plus commandés' })
  findPopular(@Query() query: PaginationQueryDto) {
    return this.productsService.findPopular(query.limit);
  }

  /**
   * GET /products/recommendations
   * Recommandations basées sur l'historique de l'utilisateur (authentifié)
   */
  @Get('recommendations')
  @ApiOperation({ summary: 'Recommandations personnalisées (authentifié)' })
  getRecommendations(
    @FirebaseUser() fbUser: DecodedIdToken,
    @Query() query: PaginationQueryDto,
  ) {
    return this.productsService.getRecommendations(fbUser.uid, query.limit);
  }

  // ─── Back-office (avant :id, sinon « manage » passerait pour un id) ────────

  /**
   * GET /products/manage
   *
   * Catalogue **du gestionnaire** : tous les produits d'un vendeur, y compris
   * ceux qu'aucun client ne voit (marqués indisponibles, hors de leur fenêtre
   * horaire, ou appartenant à un vendeur suspendu ou encore en `DRAFT`).
   *
   * Les back-offices lisaient `GET /products`, c'est-à-dire le **catalogue
   * client**. Un vendeur suspendu perdait donc l'écran depuis lequel il aurait
   * pu se remettre en conformité, et un produit rendu indisponible ne pouvait
   * plus jamais être remis en vente : il avait disparu de la seule liste qui
   * porte le bouton.
   *
   * `restaurantId` n'est lu que pour un ADMIN — un RESTAURATEUR reste chez lui.
   */
  @Get('manage')
  @Roles('RESTAURATEUR', 'ADMIN')
  @ApiOperation({
    summary: 'Mon catalogue complet (ADMIN : celui du vendeur ciblé)',
  })
  @ApiQuery({
    name: 'restaurantId',
    required: false,
    description: 'ADMIN uniquement',
  })
  @ApiQuery({ name: 'categoryId', required: false })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({
    name: 'stockStatus',
    required: false,
    enum: ['out', 'low', 'unlimited', 'tracked'],
    description:
      'Filtre de stock : out = rupture, low = 3 unités ou moins, ' +
      'unlimited = sans gestion de stock, tracked = stock suivi.',
  })
  findAllForOwner(
    @FirebaseUser() fbUser: DecodedIdToken,
    @Query() query: ProductFilterQueryDto,
  ) {
    return this.productsService.findAllForOwner(
      fbUser.uid,
      query.restaurantId,
      query.categoryId,
      query.page,
      query.limit,
      query.stockStatus,
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
   * PATCH /products/reorder
   *
   * ⚠️ Déclarée **avant** `@Patch(':id')`, sinon « reorder » serait lu comme un
   * identifiant de produit — exactement le piège que
   * `products.controller.routing.spec.ts` rend exigible pour `/manage`, et que
   * `PATCH /categories/reorder` a déjà rencontré.
   */
  @Patch('reorder')
  @Roles('RESTAURATEUR', 'ADMIN')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Réordonner ses produits (liste ordonnée complète)',
  })
  reorder(
    @Body() dto: ReorderProductsDto,
    @FirebaseUser() fbUser: DecodedIdToken,
  ) {
    return this.productsService.reorder(dto, fbUser.uid);
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
   *
   * Réapprovisionnement **explicite** : remet `stockRestant` au niveau déclaré,
   * même si `stockQuotidien` ne change pas. C'est le geste « j'ai réassorti »,
   * distinct de `PATCH /products/:id` qui décrit la fiche produit.
   *
   * ⚠️ Le corps était lu en `@Body('stockQuotidien')` brut, donc jamais validé.
   */
  @Patch(':id/stock')
  @Roles('RESTAURATEUR', 'ADMIN')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Réapprovisionner (stock déclaré + stock restant)' })
  updateStock(
    @Param('id') id: string,
    @Body() dto: UpdateProductStockDto,
    @FirebaseUser() fbUser: DecodedIdToken,
  ) {
    return this.productsService.updateStock(
      id,
      dto.stockQuotidien ?? null,
      fbUser.uid,
    );
  }

  /**
   * PATCH /products/:id/availability
   * Rend un produit disponible ou indisponible à la vente (fix M2).
   */
  @Patch(':id/availability')
  @Roles('RESTAURATEUR', 'ADMIN')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Rendre un produit disponible / indisponible' })
  setAvailability(
    @Param('id') id: string,
    @Body() dto: UpdateAvailabilityDto,
    @FirebaseUser() fbUser: DecodedIdToken,
  ) {
    return this.productsService.setAvailability(
      id,
      dto.isAvailable,
      fbUser.uid,
    );
  }

  /**
   * DELETE /products/:id
   * Retire un produit du catalogue
   */
  @Delete(':id')
  @Roles('RESTAURATEUR', 'ADMIN')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Supprimer un produit' })
  remove(@Param('id') id: string, @FirebaseUser() fbUser: DecodedIdToken) {
    return this.productsService.remove(id, fbUser.uid);
  }
}
