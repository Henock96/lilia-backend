import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { User } from '@prisma/client';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequireSecondFactor } from '../auth/decorators/require-second-factor.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import {
  AdminCancelReservationDto,
  AdminReservationsQueryDto,
} from './dto/reservation-booking.dto';
import { ReservationAdminService } from './reservation-admin.service';
import { RESERVATION_THROTTLES } from './reservation-booking-vocab';

/**
 * 4B-2 J6 (I-10) — gestes du support sur une réservation.
 *
 * Classée comme l'annulation ADMIN d'une commande qu'elle remplace pour les
 * commandes liées (`OrdersController.updateOrderStatus`) : tout
 * administrateur, second facteur exigé (`admin-route-capabilities.spec.ts`).
 * L'annulation ne fait partir aucun argent ; le remboursement d'une
 * réservation payée est exécuté par la file admin (quatre yeux au-delà du
 * seuil).
 */
@ApiTags('Réservations sur place (admin)')
@ApiBearerAuth()
@Controller('admin/reservations')
@Roles('ADMIN')
export class AdminReservationsController {
  constructor(private readonly reservations: ReservationAdminService) {}

  // D-6 — lecture pour tout administrateur ; le numéro complet du client
  // n'apparaît que sur le détail (D6-4).
  @Get()
  @ApiOperation({ summary: 'Réservations, par restaurant, jour et statut' })
  list(@Query() query: AdminReservationsQueryDto) {
    return this.reservations.list(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Détail d’une réservation (contact du client)' })
  async get(@Param('id') id: string) {
    return { data: await this.reservations.get(id) };
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @Throttle(RESERVATION_THROTTLES.vendorGesture)
  @RequireSecondFactor()
  @ApiOperation({
    summary:
      'Annuler une réservation (support) : commande liée annulée, remboursement intégral par la file admin si payée',
  })
  cancel(
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Body() dto: AdminCancelReservationDto,
  ) {
    return this.reservations.cancel(user.id, id, dto.reason);
  }
}
