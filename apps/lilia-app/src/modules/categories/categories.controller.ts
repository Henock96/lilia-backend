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
import { FirebaseUser } from '../auth/decorators/firebase-user.decorator';

/**
 * Sections de menu — **propriété du vendeur**.
 *
 * Il n'y a plus de `GET /categories` global : une catégorie n'existe que
 * rattachée à un commerce.
 *
 * ## Une seule lecture, et pourquoi
 *
 * Ce contrôleur en exposait deux : celle-ci (« que puis-je remplir ? ») et
 * `GET /categories/restaurant/:restaurantId` (« qu'y a-t-il à voir ? »,
 * sections actives **et non vides**). La seconde **n'a jamais eu d'appelant** —
 * vérifié sur les cinq dépôts — parce que les sections de la carte arrivent
 * embarquées dans `GET /vendors/:id`, et que le filtre « non vide » est fait
 * côté client.
 *
 * Ce n'est pas un détail de propreté : ce filtre côté client est **plus juste**
 * que ne l'était la route. Elle regardait toute la table, quand le client, lui,
 * regarde les produits qu'il a **effectivement reçus** — donc après la borne
 * `MENU_PRODUCTS_LIMIT`. Une section dont tous les produits tombaient au-delà de
 * la borne aurait été annoncée par le serveur puis rendue vide à l'écran.
 *
 * Garder les deux, dont une morte, garantissait qu'on corrigerait un jour la
 * mauvaise. La règle « ne pas promettre une section vide » vit désormais à un
 * seul endroit par plateforme : `buildMenuModel` (web) et `_sections`
 * (application).
 */
@ApiTags('Categories')
@ApiBearerAuth()
@Controller('categories')
export class CategoriesController {
  constructor(private readonly categoriesService: CategoriesService) {}

  // ─── Lectures ──────────────────────────────────────────────────────────────

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
