/* eslint-disable prettier/prettier */
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';
import { DecodedIdToken } from 'firebase-admin/auth';

import { DeliveriesService } from './deliveries.service';
import { AssignDeliveryDto, DeliveryStatus, UpdateDeliveryStatusDto } from './dto/update-delivery.dto';
import { UpdateLocationDto } from './dto/update-location.dto';
import { FirebaseUser } from '../auth/decorators/firebase-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { DriverStatus } from '@prisma/client';

@ApiTags('Deliveries')
@ApiBearerAuth()
@Controller('deliveries')
export class DeliveriesController {
  constructor(private readonly deliveriesService: DeliveriesService) {}

  /**
   * GET /deliveries/restaurant
   * Récupère toutes les livraisons pour le restaurant du propriétaire connecté
   */
  @Get('restaurant')
  @Roles('RESTAURATEUR', 'ADMIN')
  @ApiOperation({ summary: 'Livraisons du restaurant connecté' })
  @ApiQuery({ name: 'status', required: false, enum: DeliveryStatus })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  findAllForRestaurant(
    @FirebaseUser() fbUser: DecodedIdToken,
    @Query('status') status?: DeliveryStatus,
    @Query('page') page = '1',
    @Query('limit') limit = '20',
  ) {
    return this.deliveriesService.findAllForRestaurant(
      fbUser.uid,
      status,
      parseInt(page, 10),
      parseInt(limit, 10) ,
    );
  }

  /**
   * GET /deliveries/mine
   * Récupère les livraisons assignées au livreur connecté
   */
  @Get('mine')
  @Roles('LIVREUR')
  @Roles('LIVREUR')
  @ApiOperation({ summary: 'Mes livraisons assignées (livreur)' })
  @ApiQuery({ name: 'status', required: false, enum: DeliveryStatus })
  findMyDeliveries(@FirebaseUser() fbUser: DecodedIdToken, @Query('status') status?: DeliveryStatus) {
    return this.deliveriesService.findAllForDeliverer(fbUser.uid, status);
  }

  /**
   * GET /deliveries/deliverers
   * Récupère la liste des livreurs disponibles
   */
  @Get('deliverers')
  @Roles('RESTAURATEUR', 'ADMIN')
  @ApiOperation({ summary: 'Livreurs disponibles' })
  getAvailableDeliverers() {
    return this.deliveriesService.getAvailableDeliverers();
  }

  @Get('my-missions')
  @Roles('LIVREUR')
  getMyMissions(@FirebaseUser() fbUser: DecodedIdToken) {
    return this.deliveriesService.getMyAssignedDeliveries(fbUser.uid);
  }

  @Patch('driver-status')
  @Roles('LIVREUR')
  @HttpCode(HttpStatus.OK)
  setStatus(
    @FirebaseUser() fbUser: DecodedIdToken,
    @Body('status') status: DriverStatus,
  ) {
    return this.deliveriesService.setDriverStatus(fbUser.uid, status);
  }

  /**
   * GET /deliveries/by-order/:orderId
   * Récupère la livraison et la position du livreur pour une commande (côté client)
   */
  @Get('by-order/:orderId')
  @Roles('CLIENT', 'RESTAURATEUR', 'ADMIN', 'LIVREUR')
  @ApiOperation({ summary: 'Position du livreur pour une commande' })
  @ApiParam({ name: 'orderId' })
  findByOrderId(@Param('orderId') orderId: string) {
    return this.deliveriesService.findByOrderId(orderId);
  }

  /**
   * GET /deliveries/:id
   * Récupère une livraison par son ID
   */
  @Get(':id')
  @Roles('RESTAURATEUR', 'ADMIN', 'LIVREUR')
  @ApiOperation({ summary: 'Détail d\'une livraison' })
  @ApiParam({ name: 'id' })
  findOne(@Param('id') id: string) {
    return this.deliveriesService.findOne(id);
  }

  /**
   * PATCH /deliveries/:id/status
   * Met à jour le statut d'une livraison
   */
  @Patch(':id/status')
  @Roles('RESTAURATEUR', 'ADMIN', 'LIVREUR')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mettre à jour le statut d\'une livraison' })
  updateStatus(
    @Param('id') id: string,
    @Body() dto: UpdateDeliveryStatusDto,
    @FirebaseUser() fbUser: DecodedIdToken,
  ) {
    return this.deliveriesService.updateStatus(id, dto.status, fbUser.uid);
  }

  /**
   * PATCH /deliveries/:id/assign
   * Assigne un livreur à une livraison
   */
  @Patch(':id/assign')
  @Roles('RESTAURATEUR', 'ADMIN')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Assigner un livreur' })
  assignDeliverer(
    @Param('id') id: string,
    @Body() dto: AssignDeliveryDto,
    @FirebaseUser() fbUser: DecodedIdToken,
  ) {
    return this.deliveriesService.assignDeliverer(id, dto.delivererId, fbUser.uid);
  }

  @Patch(':id/accept')
  @Roles('LIVREUR')
  @HttpCode(HttpStatus.OK)
  acceptDelivery(
    @Param('id') id: string,
    @FirebaseUser() fbUser: DecodedIdToken,
  ) {
    return this.deliveriesService.acceptDelivery(id, fbUser.uid);
  }

  /**
   * PATCH /deliveries/:id/location
   * Le livreur met à jour sa position GPS (uniquement EN_TRANSIT)
   */
  @Patch(':id/location')
  @Roles('LIVREUR')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mettre à jour la position GPS du livreur' })
  updateLocation(
    @Param('id') id: string,
    @Body() dto: UpdateLocationDto,
    @FirebaseUser() fbUser: DecodedIdToken,
  ) {
    return this.deliveriesService.updateLocation(id, dto.latitude, dto.longitude, dto.accuracy, fbUser.uid);
  }
}
