import {
  Body,
  Controller,
  Get,
  Headers,
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
import { Public } from '../auth/decorators/public.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import {
  AvailabilityQueryDto,
  CreateReservationDto,
  MyReservationsQueryDto,
  PayReservationDto,
} from './dto/reservation-booking.dto';
import { RESERVATION_THROTTLES } from './reservation-booking-vocab';
import { ReservationBookingService } from './reservation-booking.service';
import { ReservationPaymentService } from './reservation-payment.service';

/**
 * Lot 4 — heures libres d'un restaurant, lisibles sans compte (zone
 * « découvrir ») : on choisit une heure avant de se connecter pour réserver.
 * Rien ne révèle la capacité ; un restaurant non réservable répond 404.
 */
@ApiTags('Réservations sur place (client)')
@Controller('vendors')
export class ReservationAvailabilityController {
  constructor(private readonly booking: ReservationBookingService) {}

  // Recalcule une journée de créneaux : borné à part du throttle global.
  @Public()
  @Throttle({ short: { limit: 5, ttl: 1000 }, long: { limit: 60, ttl: 60000 } })
  @Get(':id/reservation-availability')
  @ApiOperation({
    summary:
      'Heures d’arrivée libres pour une date et un groupe (sans date : les bornes)',
  })
  async availability(
    @Param('id') restaurantId: string,
    @Query() query: AvailabilityQueryDto,
  ) {
    return { data: await this.booking.availability(restaurantId, query) };
  }
}

/**
 * Lot 4 — les réservations du client connecté. Une réservation d'un autre
 * client répond 404 (aucune fuite d'existence).
 */
@ApiTags('Réservations sur place (client)')
@ApiBearerAuth()
@Controller('reservations')
@Roles('CLIENT')
export class ReservationsController {
  constructor(
    private readonly booking: ReservationBookingService,
    private readonly payments: ReservationPaymentService,
  ) {}

  @Throttle({ short: { limit: 1, ttl: 1000 }, long: { limit: 10, ttl: 60000 } })
  @Post()
  @ApiOperation({
    summary:
      'Demander une table avec sa précommande (le panier) — Idempotency-Key requis',
  })
  async create(
    @CurrentUser() user: User,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() dto: CreateReservationDto,
  ) {
    return {
      data: await this.booking.create(user, idempotencyKey, dto),
      message: 'Demande envoyée au restaurant.',
    };
  }

  // Déclarée AVANT `:id` : sinon « me » serait lu comme un identifiant.
  @Get('me')
  @ApiOperation({ summary: 'Mes réservations' })
  mine(@CurrentUser() user: User, @Query() query: MyReservationsQueryDto) {
    return this.booking.listMine(user.id, query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Une de mes réservations' })
  async one(@CurrentUser() user: User, @Param('id') id: string) {
    return { data: await this.booking.getMine(user.id, id) };
  }

  /**
   * 4B-2 — payer la précommande acceptée (si `allowedActions` contient
   * `pay`). Même borne que `POST /payments` : chaque appel peut déclencher
   * une demande facturée chez le prestataire.
   */
  @Throttle({ short: { limit: 1, ttl: 1000 }, long: { limit: 10, ttl: 60000 } })
  @Post(':id/pay')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Payer ma précommande acceptée — montant de la commande liée, `expectedTotal` = total affiché',
  })
  async pay(
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Body() dto: PayReservationDto,
    @Headers('x-lilia-payment-flow') clientFlow?: string,
  ) {
    return { data: await this.payments.pay(user, id, dto, clientFlow) };
  }

  @Throttle(RESERVATION_THROTTLES.clientCancel)
  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Annuler ma demande (si `allowedActions` le permet)',
  })
  async cancel(@CurrentUser() user: User, @Param('id') id: string) {
    return {
      data: await this.booking.cancel(user.id, id),
      message: 'Réservation annulée.',
    };
  }
}
