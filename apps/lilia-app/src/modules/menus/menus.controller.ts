/* eslint-disable prettier/prettier */
import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  Query,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiQuery,
} from '@nestjs/swagger';
import { MenusService } from './menus.service';
import { CreateMenuDto, UpdateMenuDto } from './dto';
import { FirebaseUser } from '../auth/decorators/firebase-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { DecodedIdToken } from 'firebase-admin/auth';

@ApiTags('Menus')
@ApiBearerAuth()
@Controller('menus')
export class MenusController {
  constructor(private readonly menusService: MenusService) {}
  // ─── Routes publiques ──────────────────────────────────────────────────────

  @Post()
  @Roles('RESTAURATEUR', 'ADMIN')
  @ApiOperation({ summary: 'Créer un nouveau menu (Restaurateur uniquement)' })
  @ApiResponse({ status: 201, description: 'Menu créé avec succès' })
  @ApiResponse({ status: 400, description: 'Données invalides' })
  @ApiResponse({ status: 403, description: 'Accès refusé' })
  create(@Body() createMenuDto: CreateMenuDto, @FirebaseUser() fbUser: DecodedIdToken) {
    return this.menusService.create(createMenuDto, fbUser.uid);
  }

  @Public()
  @Get()
  @ApiOperation({ summary: 'Récupérer tous les menus avec filtres optionnels' })
  @ApiQuery({
    name: 'restaurantId',
    required: false,
    description: 'Filtrer par ID de restaurant',
  })
  @ApiQuery({
    name: 'isActive',
    required: false,
    description: 'Filtrer par statut actif',
    type: Boolean,
  })
  @ApiQuery({
    name: 'includeExpired',
    required: false,
    description: 'Inclure les menus expirés',
    type: Boolean,
  })
  @ApiResponse({ status: 200, description: 'Liste des menus récupérée' })
  findAll(
    @Query('restaurantId') restaurantId?: string,
    @Query('isActive') isActive?: string,
    @Query('includeExpired') includeExpired?: string,
  ) {
     return this.menusService.findAll({
      restaurantId,
      ...(isActive !== undefined && { isActive: isActive === 'true' }),
      ...(includeExpired !== undefined && { includeExpired: includeExpired === 'true' }),
    });
  }

  @Public()
  @Get('active')
  @ApiOperation({ summary: 'Récupérer les menus actifs du jour' })
  @ApiQuery({
    name: 'restaurantId',
    required: false,
    description: 'Filtrer par ID de restaurant',
  })
  @ApiResponse({ status: 200, description: 'Menus actifs récupérés' })
  getActiveMenus(@Query('restaurantId') restaurantId?: string) {
    return this.menusService.getActiveMenus(restaurantId);
  }

  @Get('restaurant/mine')
  @Roles('RESTAURATEUR', 'ADMIN')
  @ApiOperation({
    summary: 'Récupérer tous les menus du restaurant du propriétaire',
  })
  @ApiResponse({ status: 200, description: 'Menus du restaurant récupérés' })
  @ApiResponse({ status: 403, description: 'Accès refusé' })
  findByRestaurant(@FirebaseUser() fbUser: DecodedIdToken) {
    return this.menusService.findByRestaurant(fbUser.uid);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Récupérer un menu par son ID' })
  @ApiResponse({ status: 200, description: 'Menu récupéré avec succès' })
  @ApiResponse({ status: 404, description: 'Menu non trouvé' })
  findOne(@Param('id') id: string) {
    return this.menusService.findOne(id);
  }
  // ─── Routes protégées ──────────────────────────────────────────────────────

  @Patch(':id')
  @Roles('RESTAURATEUR', 'ADMIN')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mettre à jour un menu (Restaurateur uniquement)' })
  @ApiResponse({ status: 200, description: 'Menu mis à jour avec succès' })
  @ApiResponse({ status: 400, description: 'Données invalides' })
  @ApiResponse({ status: 403, description: 'Accès refusé' })
  @ApiResponse({ status: 404, description: 'Menu non trouvé' })
  update(
    @Param('id') id: string,
    @Body() updateMenuDto: UpdateMenuDto,
    @FirebaseUser() fbUser: DecodedIdToken,
  ) {
    return this.menusService.update(id, updateMenuDto, fbUser.uid);
  }

  @Patch(':id/stock')
  @HttpCode(HttpStatus.OK)
  @Roles('RESTAURATEUR', 'ADMIN')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Mettre à jour le stock d\'un menu' })
  @ApiResponse({ status: 200, description: 'Stock mis à jour avec succès' })
  @ApiResponse({ status: 404, description: 'Menu non trouvé' })
  updateStock(
    @Param('id') id: string,
    @Body('stockQuotidien') stockQuotidien: number | null,
    @FirebaseUser() fbUser: DecodedIdToken,

  ) {
    return this.menusService.updateStock(id, stockQuotidien, fbUser.uid);
  }

  @Patch(':id/toggle')
  @Roles('RESTAURATEUR', 'ADMIN')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Activer/désactiver un menu (Restaurateur uniquement)',
  })
  @ApiResponse({
    status: 200,
    description: 'Statut du menu modifié avec succès',
  })
  @ApiResponse({ status: 403, description: 'Accès refusé' })
  @ApiResponse({ status: 404, description: 'Menu non trouvé' })
  toggleActive(@Param('id') id: string, @FirebaseUser() fbUser: DecodedIdToken) {
    return this.menusService.toggleActive(id, fbUser.uid);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @Roles('RESTAURATEUR', 'ADMIN')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Supprimer un menu (Restaurateur uniquement)' })
  @ApiResponse({ status: 200, description: 'Menu supprimé avec succès' })
  @ApiResponse({ status: 403, description: 'Accès refusé' })
  @ApiResponse({ status: 404, description: 'Menu non trouvé' })
  remove(@Param('id') id: string, @FirebaseUser() fbUser: DecodedIdToken) {
    return this.menusService.remove(id, fbUser.uid);
  }
}
