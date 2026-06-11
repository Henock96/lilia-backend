/* eslint-disable prettier/prettier */
import { 
  Body, 
  Controller, Delete, Get, Param, Patch, Post, Query,
  HttpCode, HttpStatus, } from '@nestjs/common';
import { QuartiersService } from './quartiers.service';
import { DeliveryZonesService } from './delivery-zones.service';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { DecodedIdToken } from 'firebase-admin/auth';
import { FirebaseUser } from '../auth/decorators/firebase-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { AddQuartiersToZoneDto, CreateDeliveryZoneDto, UpdateDeliveryZoneDto } from './dto/delivery-zone.dto';

@ApiTags('Quartiers')
@ApiBearerAuth()
@Controller('quartiers')
export class QuartiersController {
  constructor(
    private readonly quartiersService: QuartiersService,
    private readonly deliveryZonesService: DeliveryZonesService,
  ) {}

  /**
   * GET /quartiers
   * Récupère la liste de tous les quartiers (public)
   */
  @Public()
  @Get()
  @ApiOperation({ summary: 'Liste des quartiers de Brazzaville' })
  async findAll() {
    const quartiers = await this.quartiersService.findAll();
    return {
      data: quartiers,
      count: quartiers.length,
    };
  }

  /**
   * POST /quartiers/seed
   * Initialise les quartiers de Brazzaville (à utiliser une seule fois)
   */
  @Post('seed')
  @Roles('ADMIN')
  @ApiOperation({ summary: 'Initialiser les quartiers (admin, une fois)' })
  async seedQuartiers() {
    return this.quartiersService.seedQuartiers();
  }

  /**
   * GET /quartiers/delivery-fee?restaurantId=xxx&quartierId=xxx
   * Calcule les frais de livraison pour un restaurant et un quartier
   */
  @Public()
  @Get('delivery-fee')
  @ApiOperation({ summary: 'Calcul frais de livraison par quartier' })
  async calculateDeliveryFee(
    @Query('restaurantId') restaurantId: string,
    @Query('quartierId') quartierId: string,
  ) {
    return this.quartiersService.calculateDeliveryFee(restaurantId, quartierId);
  }

  /**
   * GET /quartiers/restaurant-zones?restaurantId=xxx
   * Récupère les zones de livraison d'un restaurant (public)
   */
  @Public()
  @Get('restaurant-zones')
  @ApiOperation({ summary: 'Zones de livraison d\'un restaurant' })
  async getRestaurantDeliveryZones(
    @Query('restaurantId') restaurantId: string,
  ) {
    return this.deliveryZonesService.getRestaurantDeliveryZones(restaurantId);
  }

  // ============ ENDPOINTS ZONES DE LIVRAISON ============

  /**
   * GET /quartiers/my-zones
   * Récupère les zones de livraison du restaurant de l'utilisateur connecté
   */
  @Get('my-zones')
  @Roles('RESTAURATEUR', 'ADMIN')
  @ApiOperation({ summary: 'Mes zones de livraison' })
  async getMyDeliveryZones(@FirebaseUser() fbUser: DecodedIdToken) {
    return this.deliveryZonesService.getMyDeliveryZones(fbUser.uid);
  }

  /**
   * POST /quartiers/zones/:restaurantId
   * Crée une nouvelle zone de livraison
   */
  @Post('zones/:restaurantId')
  @Roles('RESTAURATEUR', 'ADMIN')
  @ApiOperation({ summary: 'Créer une zone de livraison' })
  async createDeliveryZone(
    @Param('restaurantId') restaurantId: string,
    @Body() dto: CreateDeliveryZoneDto,
    @FirebaseUser() fbUser: DecodedIdToken,
  ) {
    return this.deliveryZonesService.createDeliveryZone(restaurantId, fbUser.uid, dto);
  }

  /**
   * PATCH /quartiers/zones/:zoneId
   * Met à jour une zone de livraison
   */
  @Patch('zones/:zoneId')
  @Roles('RESTAURATEUR', 'ADMIN')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Modifier une zone de livraison' })
  async updateDeliveryZone(
    @Param('zoneId') zoneId: string,
    @Body() dto: UpdateDeliveryZoneDto,
    @FirebaseUser() fbUser: DecodedIdToken,
  ) {
    return this.deliveryZonesService.updateDeliveryZone(zoneId, fbUser.uid, dto);
  }

  /**
   * DELETE /quartiers/zones/:zoneId
   * Supprime une zone de livraison
   */
  @Delete('zones/:zoneId')
  @Roles('RESTAURATEUR', 'ADMIN')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Supprimer une zone de livraison' })
  async deleteDeliveryZone(
    @Param('zoneId') zoneId: string,
    @FirebaseUser() fbUser: DecodedIdToken,
  ) {
    return this.deliveryZonesService.deleteDeliveryZone(zoneId, fbUser.uid);
  }

  /**
   * POST /quartiers/zones/:zoneId/quartiers
   * Ajoute des quartiers à une zone
   */
  @Post('zones/:zoneId/quartiers')
  @Roles('RESTAURATEUR', 'ADMIN')
  @ApiOperation({ summary: 'Ajouter des quartiers à une zone' })
  async addQuartiersToZone(
    @Param('zoneId') zoneId: string,
    @Body() dto: AddQuartiersToZoneDto,
    @FirebaseUser() fbUser: DecodedIdToken,
  ) {
    return this.deliveryZonesService.addQuartiersToZone(zoneId, fbUser.uid, dto.quartierIds);
  }

  /**
   * DELETE /quartiers/zones/:zoneId/quartiers
   * Retire des quartiers d'une zone
   */
  @Delete('zones/:zoneId/quartiers')
  @Roles('RESTAURATEUR', 'ADMIN')
  async removeQuartiersFromZone(
    @Param('zoneId') zoneId: string,
    @Body() dto: AddQuartiersToZoneDto,
    @FirebaseUser() fbUser: DecodedIdToken,
  ) {
    return this.deliveryZonesService.removeQuartiersFromZone(zoneId, fbUser.uid, dto.quartierIds);
  }
}
