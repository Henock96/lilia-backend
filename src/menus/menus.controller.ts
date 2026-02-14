/* eslint-disable prettier/prettier */
import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  UseGuards,
  Req,
  Query,
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
import { FirebaseAuthGuard } from '../firebase/firebase-auth.guard';
import { RolesGuard } from '../firebase/roles.guard';
import { Roles } from '../firebase/roles.decorator';

@ApiTags('Menus')
@Controller('menus')
export class MenusController {
  constructor(private readonly menusService: MenusService) {}

  @Post()
  @UseGuards(FirebaseAuthGuard, RolesGuard)
  @Roles('RESTAURATEUR', 'ADMIN')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Créer un nouveau menu (Restaurateur uniquement)' })
  @ApiResponse({ status: 201, description: 'Menu créé avec succès' })
  @ApiResponse({ status: 400, description: 'Données invalides' })
  @ApiResponse({ status: 403, description: 'Accès refusé' })
  create(@Body() createMenuDto: CreateMenuDto, @Req() req) {
    return this.menusService.create(createMenuDto, req.user.uid);
  }

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
    const filters: any = {};
    if (restaurantId) filters.restaurantId = restaurantId;
    if (isActive !== undefined) filters.isActive = isActive === 'true';
    if (includeExpired !== undefined)
      filters.includeExpired = includeExpired === 'true';

    return this.menusService.findAll(filters);
  }

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

  @Get('restaurant')
  @UseGuards(FirebaseAuthGuard, RolesGuard)
  @Roles('RESTAURATEUR', 'ADMIN')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Récupérer tous les menus du restaurant du propriétaire',
  })
  @ApiResponse({ status: 200, description: 'Menus du restaurant récupérés' })
  @ApiResponse({ status: 403, description: 'Accès refusé' })
  findByRestaurant(@Req() req) {
    return this.menusService.findByRestaurant(req.user.uid);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Récupérer un menu par son ID' })
  @ApiResponse({ status: 200, description: 'Menu récupéré avec succès' })
  @ApiResponse({ status: 404, description: 'Menu non trouvé' })
  findOne(@Param('id') id: string) {
    return this.menusService.findOne(id);
  }

  @Patch(':id')
  @UseGuards(FirebaseAuthGuard, RolesGuard)
  @Roles('RESTAURATEUR', 'ADMIN')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Mettre à jour un menu (Restaurateur uniquement)' })
  @ApiResponse({ status: 200, description: 'Menu mis à jour avec succès' })
  @ApiResponse({ status: 400, description: 'Données invalides' })
  @ApiResponse({ status: 403, description: 'Accès refusé' })
  @ApiResponse({ status: 404, description: 'Menu non trouvé' })
  update(
    @Param('id') id: string,
    @Body() updateMenuDto: UpdateMenuDto,
    @Req() req,
  ) {
    return this.menusService.update(id, updateMenuDto, req.user.uid);
  }

  @Patch(':id/stock')
  @UseGuards(FirebaseAuthGuard, RolesGuard)
  @Roles('RESTAURATEUR', 'ADMIN')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Mettre à jour le stock d\'un menu' })
  @ApiResponse({ status: 200, description: 'Stock mis à jour avec succès' })
  @ApiResponse({ status: 404, description: 'Menu non trouvé' })
  updateStock(
    @Param('id') id: string,
    @Body('stockQuotidien') stockQuotidien: number | null,
    @Req() req,
  ) {
    return this.menusService.updateStock(id, stockQuotidien, req.user.uid);
  }

  @Patch(':id/toggle')
  @UseGuards(FirebaseAuthGuard, RolesGuard)
  @Roles('RESTAURATEUR', 'ADMIN')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Activer/désactiver un menu (Restaurateur uniquement)',
  })
  @ApiResponse({
    status: 200,
    description: 'Statut du menu modifié avec succès',
  })
  @ApiResponse({ status: 403, description: 'Accès refusé' })
  @ApiResponse({ status: 404, description: 'Menu non trouvé' })
  toggleActive(@Param('id') id: string, @Req() req) {
    return this.menusService.toggleActive(id, req.user.uid);
  }

  @Delete(':id')
  @UseGuards(FirebaseAuthGuard, RolesGuard)
  @Roles('RESTAURATEUR', 'ADMIN')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Supprimer un menu (Restaurateur uniquement)' })
  @ApiResponse({ status: 200, description: 'Menu supprimé avec succès' })
  @ApiResponse({ status: 403, description: 'Accès refusé' })
  @ApiResponse({ status: 404, description: 'Menu non trouvé' })
  remove(@Param('id') id: string, @Req() req) {
    return this.menusService.remove(id, req.user.uid);
  }
}
