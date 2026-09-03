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
import { DecodedIdToken } from 'firebase-admin/auth';

import { CategoriesService } from './categories.service';
import { CreateCategoryDto } from './dto/create-category.dto';
import { UpdateCategoryDto } from './dto/update-category.dto';
import { ReorderCategoriesDto } from './dto/reorder-categories.dto';
import { Roles } from '../auth/decorators/roles.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { FirebaseUser } from '../auth/decorators/firebase-user.decorator';

/**
 * Sections de menu — **propriété du vendeur**.
 *
 * Il n'y a plus de `GET /categories` global : une catégorie n'existe que
 * rattachée à un commerce. Les deux lectures répondent à deux questions
 * différentes — « que puis-je remplir ? » (vendeur, sections vides comprises) et
 * « qu'y a-t-il à voir ? » (client, sections non vides uniquement).
 */
@ApiTags('Categories')
@ApiBearerAuth()
@Controller('categories')
export class CategoriesController {
  constructor(private readonly categoriesService: CategoriesService) {}

  // ─── Lectures ──────────────────────────────────────────────────────────────

  /**
   * Vue client : sections **actives et non vides** d'un vendeur publié.
   * Déclarée avant `:id` pour ne pas être prise pour un identifiant.
   */
  @Public()
  @Get('restaurant/:restaurantId')
  @ApiOperation({
    summary: "Sections publiques d'un vendeur (actives, non vides)",
  })
  findPublicByRestaurant(@Param('restaurantId') restaurantId: string) {
    return this.categoriesService.findPublicByRestaurant(restaurantId);
  }

  /**
   * Vue vendeur / administration : **toutes** ses sections, y compris vides et
   * désactivées. `restaurantId` n'est lu que pour un ADMIN.
   */
  @Get()
  @Roles('RESTAURATEUR', 'ADMIN')
  @ApiOperation({
    summary: 'Mes sections de menu (ADMIN : celles du vendeur ciblé)',
  })
  @ApiQuery({
    name: 'restaurantId',
    required: false,
    description: 'ADMIN uniquement',
  })
  findAll(
    @FirebaseUser() fbUser: DecodedIdToken,
    @Query('restaurantId') restaurantId?: string,
  ) {
    return this.categoriesService.findAllForOwner(fbUser.uid, restaurantId);
  }

  @Get(':id')
  @Roles('RESTAURATEUR', 'ADMIN')
  @ApiOperation({ summary: 'Une section de menu' })
  findOne(@Param('id') id: string, @FirebaseUser() fbUser: DecodedIdToken) {
    return this.categoriesService.findOne(id, fbUser.uid);
  }

  // ─── Écritures ─────────────────────────────────────────────────────────────

  @Post()
  @Roles('RESTAURATEUR', 'ADMIN')
  @ApiOperation({ summary: 'Créer une section de menu' })
  create(
    @Body() dto: CreateCategoryDto,
    @FirebaseUser() fbUser: DecodedIdToken,
  ) {
    return this.categoriesService.create(dto, fbUser.uid);
  }

  /**
   * Réordonnancement — déclaré **avant** `PATCH :id`, sinon « reorder » serait
   * interprété comme un identifiant de catégorie.
   */
  @Patch('reorder')
  @Roles('RESTAURATEUR', 'ADMIN')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Réordonner ses sections (liste ordonnée complète)',
  })
  reorder(
    @Body() dto: ReorderCategoriesDto,
    @FirebaseUser() fbUser: DecodedIdToken,
  ) {
    return this.categoriesService.reorder(dto, fbUser.uid);
  }

  @Patch(':id')
  @Roles('RESTAURATEUR', 'ADMIN')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Modifier une section (nom, ordre, activation)' })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateCategoryDto,
    @FirebaseUser() fbUser: DecodedIdToken,
  ) {
    return this.categoriesService.update(id, dto, fbUser.uid);
  }

  /**
   * Supprime la section, **jamais** ses produits : ils sont détachés et restent
   * en vente. La suppression n'est donc plus refusée quand la section est
   * remplie — c'était le geste normal d'un vendeur qui réorganise sa carte.
   */
  @Delete(':id')
  @Roles('RESTAURATEUR', 'ADMIN')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Supprimer une section (les produits sont détachés)',
  })
  remove(@Param('id') id: string, @FirebaseUser() fbUser: DecodedIdToken) {
    return this.categoriesService.remove(id, fbUser.uid);
  }
}
