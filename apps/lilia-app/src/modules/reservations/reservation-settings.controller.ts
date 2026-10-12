import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Put,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { User } from '@prisma/client';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import {
  ReservationDraftDto,
  SaveReservationSettingsDto,
} from './dto/reservation-settings.dto';
import { ReservationSettingsService } from './reservation-settings.service';

/**
 * Premium (Lot 3) — « Réservations sur place » : le restaurateur configure
 * SON restaurant (`ownerId`) ; l'identifiant du restaurant ne vient jamais de
 * la requête. Lecture et aperçu ouverts au Standard ; enregistrement réservé
 * au Premium actif, vérifié par le serveur à chaque `PUT`.
 */
@ApiTags('Réservations sur place (vendeur)')
@ApiBearerAuth()
@Controller('vendors/me/reservation-settings')
@Roles('RESTAURATEUR')
export class ReservationSettingsController {
  constructor(private readonly reservations: ReservationSettingsService) {}

  @Get()
  @ApiOperation({
    summary: 'Ma configuration, mes droits, l’aperçu et les alertes',
  })
  async mine(@CurrentUser() user: User) {
    return { data: await this.reservations.getMine(user.id) };
  }

  // L'aperçu recalcule une semaine de créneaux à chaque appel : borné à part
  // du throttle global (revue sécurité du 12/10).
  @Throttle({ short: { limit: 3, ttl: 1000 }, long: { limit: 30, ttl: 60000 } })
  @Post('preview')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Valider un brouillon sans l’enregistrer (Premium non requis)',
  })
  async preview(@CurrentUser() user: User, @Body() dto: ReservationDraftDto) {
    return { data: await this.reservations.preview(user.id, dto) };
  }

  @Throttle({ short: { limit: 1, ttl: 1000 }, long: { limit: 20, ttl: 60000 } })
  @Put()
  @ApiOperation({ summary: 'Enregistrer la configuration (Premium requis)' })
  async save(
    @CurrentUser() user: User,
    @Body() dto: SaveReservationSettingsDto,
  ) {
    return {
      data: await this.reservations.save(user.id, dto),
      message: 'Configuration des réservations enregistrée.',
    };
  }
}
