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
import { AssignDeliveryDto, DeliveryStatus, SetDriverStatusDto, UpdateDeliveryStatusDto } from './dto/update-delivery.dto';
import { UpdateLocationDto } from './dto/update-location.dto';
import { FirebaseUser } from '../auth/decorators/firebase-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { PaginationQueryDto } from '../../common/pagination/pagination-query.dto';

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
    @Query() query: PaginationQueryDto,
    @Query('status') status?: DeliveryStatus,
  ) {
    return this.deliveriesService.findAllForRestaurant(
      fbUser.uid,
      status,
      query.page,
      query.limit,
    );
  }

  /**
   * GET /deliveries/mine
   * Récupère les livraisons assignées au livreur connecté
   */
  @Get('mine')
  @Roles('LIVREUR')
  @ApiOperation({ summary: 'Mes livraisons assignées (livreur)' })
  @ApiQuery({ name: 'status', required: false, enum: DeliveryStatus })
  findMyDeliveries(
    @FirebaseUser() fbUser: DecodedIdToken,
    @Query() pagination: PaginationQueryDto,
    @Query('status') status?: DeliveryStatus,
  ) {
    return this.deliveriesService.findAllForDeliverer(
      fbUser.uid,
      status,
      pagination.page,
      pagination.limit,
    );
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
    @Body() dto: SetDriverStatusDto,
  ) {
    return this.deliveriesService.setDriverStatus(fbUser.uid, dto.status);
  }

  /**
   * GET /deliveries/by-order/:orderId
   * Récupère la livraison et la position du livreur pour une commande (côté client)
   */
  @Get('by-order/:orderId')
  @Roles('CLIENT', 'RESTAURATEUR', 'ADMIN', 'LIVREUR')
  @ApiOperation({ summary: 'Position du livreur pour une commande' })
  @ApiParam({ name: 'orderId' })
  findByOrderId(
    @Param('orderId') orderId: string,
    @FirebaseUser() fbUser: DecodedIdToken,
  ) {
    return this.deliveriesService.findByOrderId(orderId, fbUser.uid);
  }

  /**
   * PATCH /deliveries/by-order/:orderId/assign
   * Assigne un livreur à une commande (crée la livraison si elle n'existe pas)
   */
  @Patch('by-order/:orderId/assign')
  @Roles('RESTAURATEUR', 'ADMIN')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Assigner un livreur via l\'ID commande' })
  @ApiParam({ name: 'orderId' })
  assignDelivererToOrder(
    @Param('orderId') orderId: string,
    @Body() dto: AssignDeliveryDto,
    @FirebaseUser() fbUser: DecodedIdToken,
  ) {
    return this.deliveriesService.assignDelivererToOrder(orderId, dto.delivererId, fbUser.uid);
  }

  /**
   * GET /deliveries/:id
   * Récupère une livraison par son ID
   */
  @Get(':id')
  @Roles('RESTAURATEUR', 'ADMIN', 'LIVREUR')
  @ApiOperation({ summary: 'Détail d\'une livraison' })
  @ApiParam({ name: 'id' })
  findOne(@Param('id') id: string, @FirebaseUser() fbUser: DecodedIdToken) {
    return this.deliveriesService.findOne(id, fbUser.uid);
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
    return this.deliveriesService.updateStatus(
      id,
      dto.status,
      fbUser.uid,
      dto.reason,
    );
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
   * PATCH /deliveries/:id/pickup
   *
   * Le livreur confirme avoir récupéré le repas au restaurant. C'est ce geste
   * — et non l'acceptation de la mission — qui fait passer la commande en
   * EN_ROUTE et déclenche le « votre commande est en route » côté client.
   */
  @Patch(':id/pickup')
  @Roles('LIVREUR')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Confirmer la récupération du repas au restaurant' })
  @ApiParam({ name: 'id' })
  confirmPickup(
    @Param('id') id: string,
    @FirebaseUser() fbUser: DecodedIdToken,
  ) {
    return this.deliveriesService.confirmPickup(id, fbUser.uid);
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
