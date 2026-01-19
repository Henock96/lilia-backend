import { Body, Controller, Get, Param, Patch, Query, Req, UseGuards } from '@nestjs/common';
import { DeliveriesService } from './deliveries.service';
import { AssignDeliveryDto, DeliveryStatus, UpdateDeliveryStatusDto } from './dto/update-delivery.dto';
import { FirebaseAuthGuard } from 'src/firebase/firebase-auth.guard';
import { RolesGuard } from 'src/firebase/roles.guard';
import { Roles } from 'src/firebase/roles.decorator';

@Controller('deliveries')
@UseGuards(FirebaseAuthGuard, RolesGuard)
export class DeliveriesController {
  constructor(private readonly deliveriesService: DeliveriesService) {}

  /**
   * GET /deliveries/restaurant
   * Récupère toutes les livraisons pour le restaurant du propriétaire connecté
   */
  @Get('restaurant')
  @Roles('RESTAURATEUR', 'ADMIN')
  findAllForRestaurant(
    @Req() req,
    @Query('status') status?: DeliveryStatus,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.deliveriesService.findAllForRestaurant(
      req.user.uid,
      status,
      page ? parseInt(page, 10) : 1,
      limit ? parseInt(limit, 10) : 20,
    );
  }

  /**
   * GET /deliveries/mine
   * Récupère les livraisons assignées au livreur connecté
   */
  @Get('mine')
  @Roles('LIVREUR')
  findMyDeliveries(@Req() req, @Query('status') status?: DeliveryStatus) {
    return this.deliveriesService.findAllForDeliverer(req.user.uid, status);
  }

  /**
   * GET /deliveries/deliverers
   * Récupère la liste des livreurs disponibles
   */
  @Get('deliverers')
  @Roles('RESTAURATEUR', 'ADMIN')
  getAvailableDeliverers() {
    return this.deliveriesService.getAvailableDeliverers();
  }

  /**
   * GET /deliveries/:id
   * Récupère une livraison par son ID
   */
  @Get(':id')
  @Roles('RESTAURATEUR', 'ADMIN', 'LIVREUR')
  findOne(@Param('id') id: string) {
    return this.deliveriesService.findOne(id);
  }

  /**
   * PATCH /deliveries/:id/status
   * Met à jour le statut d'une livraison
   */
  @Patch(':id/status')
  @Roles('RESTAURATEUR', 'ADMIN', 'LIVREUR')
  updateStatus(
    @Param('id') id: string,
    @Body() dto: UpdateDeliveryStatusDto,
    @Req() req,
  ) {
    return this.deliveriesService.updateStatus(id, dto.status, req.user.uid);
  }

  /**
   * PATCH /deliveries/:id/assign
   * Assigne un livreur à une livraison
   */
  @Patch(':id/assign')
  @Roles('RESTAURATEUR', 'ADMIN')
  assignDeliverer(
    @Param('id') id: string,
    @Body() dto: AssignDeliveryDto,
    @Req() req,
  ) {
    return this.deliveriesService.assignDeliverer(id, dto.delivererId, req.user.uid);
  }
}
