/* eslint-disable prettier/prettier */
import { Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { QuartiersService } from './quartiers.service';
import { FirebaseAuthGuard } from 'src/firebase/firebase-auth.guard';

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
   * Récupère les zones de livraison d'un restaurant
   */
  @Get('restaurant-zones')
  async getRestaurantDeliveryZones(
    @Query('restaurantId') restaurantId: string,
  ) {
    return this.quartiersService.getRestaurantDeliveryZones(restaurantId);
  }
}
