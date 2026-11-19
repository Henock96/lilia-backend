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
import { Roles } from '../auth/decorators/roles.decorator';
import {
  DeclineReservationDto,
  ReassignReservationDto,
  VendorCancelReservationDto,
  VendorReservationsQueryDto,
} from './dto/reservation-booking.dto';
import { RESERVATION_THROTTLES } from './reservation-booking-vocab';
import { ReservationVendorService } from './reservation-vendor.service';

/** P-06 — chaque geste vendeur : 5/s, 60/min. */
const GESTURE = RESERVATION_THROTTLES.vendorGesture;

/**
 * Lot 4 — le restaurateur gère les réservations de SON restaurant (`ownerId`) ;
 * l'identifiant du restaurant ne vient jamais de la requête. Chaque geste
 * n'aboutit que s'il figure dans `allowedActions` (verdict serveur).
 */
@ApiTags('Réservations sur place (vendeur)')
@ApiBearerAuth()
@Controller('vendors/me/reservations')
@Roles('RESTAURATEUR')
export class VendorReservationsController {
  constructor(private readonly reservations: ReservationVendorService) {}

  @Get()
  @ApiOperation({ summary: 'Mes réservations, par jour et par statut' })
  list(@CurrentUser() user: User, @Query() query: VendorReservationsQueryDto) {
    return this.reservations.list(user.id, query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Une réservation de mon restaurant' })
  async one(@CurrentUser() user: User, @Param('id') id: string) {
    return { data: await this.reservations.get(user.id, id) };
  }

  @Throttle(GESTURE)
  @Post(':id/accept')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Accepter la demande (le client a 15 min pour payer)',
  })
  async accept(@CurrentUser() user: User, @Param('id') id: string) {
    return {
      data: await this.reservations.accept(user.id, id),
      message: 'Demande acceptée.',
    };
  }

  @Throttle(GESTURE)
  @Post(':id/decline')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Refuser la demande (motif obligatoire)' })
  async decline(
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Body() dto: DeclineReservationDto,
  ) {
    return {
      data: await this.reservations.decline(user.id, id, dto),
      message: 'Demande refusée.',
    };
  }

  @Throttle(GESTURE)
  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Annuler une réservation (motif obligatoire)' })
  async cancel(
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Body() dto: VendorCancelReservationDto,
  ) {
    return {
      data: await this.reservations.cancel(user.id, id, dto),
      message: 'Réservation annulée.',
    };
  }

  @Throttle(GESTURE)
  @Post(':id/no-show')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Déclarer le client absent' })
  async noShow(@CurrentUser() user: User, @Param('id') id: string) {
    return {
      data: await this.reservations.markNoShow(user.id, id),
      message: 'Absence enregistrée.',
    };
  }

  @Throttle(GESTURE)
  @Post(':id/undo-no-show')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Retirer une absence déclarée par erreur (6 h)' })
  async undoNoShow(@CurrentUser() user: User, @Param('id') id: string) {
    return {
      data: await this.reservations.undoNoShow(user.id, id),
      message: 'Absence retirée.',
    };
  }

  @Throttle(GESTURE)
  @Post(':id/reassign')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Déplacer vers une autre table du même type' })
  async reassign(
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Body() dto: ReassignReservationDto,
  ) {
    return {
      data: await this.reservations.reassign(user.id, id, dto.spaceId),
      message: 'Table changée ; le client est prévenu.',
    };
  }
}
