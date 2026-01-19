/* eslint-disable prettier/prettier */
import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { QuartiersService } from './quartiers.service';
import { FirebaseAuthGuard } from 'src/firebase/firebase-auth.guard';
import { RolesGuard } from 'src/firebase/roles.guard';
import { Roles } from 'src/firebase/roles.decorator';
import { AddQuartiersToZoneDto, CreateDeliveryZoneDto, UpdateDeliveryZoneDto } from './dto/delivery-zone.dto';

@Controller('quartiers')
export class QuartiersController {
  constructor(private readonly quartiersService: QuartiersService) {}

  /**
   * GET /quartiers
   * Récupère la liste de tous les quartiers
   */
  @Get()
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
  async seedQuartiers() {
    return this.quartiersService.seedQuartiers();
  }

  /**
   * GET /quartiers/delivery-fee?restaurantId=xxx&quartierId=xxx
   * Calcule les frais de livraison pour un restaurant et un quartier
   */
  @Get('delivery-fee')
  @UseGuards(FirebaseAuthGuard)
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
  @Get('restaurant-zones')
  async getRestaurantDeliveryZones(
    @Query('restaurantId') restaurantId: string,
  ) {
    return this.quartiersService.getRestaurantDeliveryZones(restaurantId);
  }

  // ============ ENDPOINTS ZONES DE LIVRAISON ============

  /**
   * GET /quartiers/my-zones
   * Récupère les zones de livraison du restaurant de l'utilisateur connecté
   */
  @Get('my-zones')
  @UseGuards(FirebaseAuthGuard, RolesGuard)
  @Roles('RESTAURATEUR', 'ADMIN')
  async getMyDeliveryZones(@Req() req) {
    return this.quartiersService.getMyDeliveryZones(req.user.uid);
  }

  /**
   * POST /quartiers/zones/:restaurantId
   * Crée une nouvelle zone de livraison
   */
  @Post('zones/:restaurantId')
  @UseGuards(FirebaseAuthGuard, RolesGuard)
  @Roles('RESTAURATEUR', 'ADMIN')
  async createDeliveryZone(
    @Param('restaurantId') restaurantId: string,
    @Body() dto: CreateDeliveryZoneDto,
    @Req() req,
  ) {
    return this.quartiersService.createDeliveryZone(restaurantId, req.user.uid, dto);
  }

  /**
   * PATCH /quartiers/zones/:zoneId
   * Met à jour une zone de livraison
   */
  @Patch('zones/:zoneId')
  @UseGuards(FirebaseAuthGuard, RolesGuard)
  @Roles('RESTAURATEUR', 'ADMIN')
  async updateDeliveryZone(
    @Param('zoneId') zoneId: string,
    @Body() dto: UpdateDeliveryZoneDto,
    @Req() req,
  ) {
    return this.quartiersService.updateDeliveryZone(zoneId, req.user.uid, dto);
  }

  /**
   * DELETE /quartiers/zones/:zoneId
   * Supprime une zone de livraison
   */
  @Delete('zones/:zoneId')
  @UseGuards(FirebaseAuthGuard, RolesGuard)
  @Roles('RESTAURATEUR', 'ADMIN')
  async deleteDeliveryZone(
    @Param('zoneId') zoneId: string,
    @Req() req,
  ) {
    return this.quartiersService.deleteDeliveryZone(zoneId, req.user.uid);
  }

  /**
   * POST /quartiers/zones/:zoneId/quartiers
   * Ajoute des quartiers à une zone
   */
  @Post('zones/:zoneId/quartiers')
  @UseGuards(FirebaseAuthGuard, RolesGuard)
  @Roles('RESTAURATEUR', 'ADMIN')
  async addQuartiersToZone(
    @Param('zoneId') zoneId: string,
    @Body() dto: AddQuartiersToZoneDto,
    @Req() req,
  ) {
    return this.quartiersService.addQuartiersToZone(zoneId, req.user.uid, dto.quartierIds);
  }

  /**
   * DELETE /quartiers/zones/:zoneId/quartiers
   * Retire des quartiers d'une zone
   */
  @Delete('zones/:zoneId/quartiers')
  @UseGuards(FirebaseAuthGuard, RolesGuard)
  @Roles('RESTAURATEUR', 'ADMIN')
  async removeQuartiersFromZone(
    @Param('zoneId') zoneId: string,
    @Body() dto: AddQuartiersToZoneDto,
    @Req() req,
  ) {
    return this.quartiersService.removeQuartiersFromZone(zoneId, req.user.uid, dto.quartierIds);
  }
}
