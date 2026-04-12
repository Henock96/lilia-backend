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
import { FirebaseUser } from '../auth/decorators/firebase-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';

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
}
