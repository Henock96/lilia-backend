import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpException,
  HttpStatus,
  Post,
  Put,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiHeader,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
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
 * 4C-0 (D-5) — capacité déclarée par l'app vendeurs qui affiche l'agenda des
 * réservations (`agenda`). Déclarative, comme `X-Lilia-Order-Flow` : ce n'est
 * pas une barrière de sécurité, c'est l'assurance qu'une app installée ne
 * laisse pas expirer des demandes qu'elle ne sait pas montrer.
 */
export const RESERVATIONS_CAPABILITY_HEADER = 'x-lilia-reservations';
const AGENDA_CAPABILITY = 'agenda';
const HTTP_UPGRADE_REQUIRED = 426;

export function declaresReservationAgenda(raw: string | undefined): boolean {
  return (
    typeof raw === 'string' &&
    raw
      .split(',')
      .some((part) => part.trim().toLowerCase() === AGENDA_CAPABILITY)
  );
}

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
  @ApiHeader({
    name: RESERVATIONS_CAPABILITY_HEADER,
    required: false,
    description:
      'Capacité de l’app vendeurs (`agenda`). Exigée seulement pour activer les réservations (`enabled: true`), sinon 426 VENDOR_APP_UPDATE_REQUIRED.',
  })
  async save(
    @CurrentUser() user: User,
    @Body() dto: SaveReservationSettingsDto,
    @Headers(RESERVATIONS_CAPABILITY_HEADER) capability?: string,
  ) {
    // 4C-0 (F-7, D-5) — allumer les réservations depuis une app qui ne sait
    // pas afficher l'agenda, c'est laisser les demandes expirer sans être
    // vues. Éteindre reste toujours permis.
    if (dto.enabled && !declaresReservationAgenda(capability)) {
      throw new HttpException(
        {
          message:
            'Pour recevoir des réservations, mettez à jour l’application vendeurs : cette version ne sait pas encore afficher les demandes des clients.',
          code: 'VENDOR_APP_UPDATE_REQUIRED',
        },
        HTTP_UPGRADE_REQUIRED,
      );
    }
    return {
      data: await this.reservations.save(user.id, dto),
      message: 'Configuration des réservations enregistrée.',
    };
  }
}
