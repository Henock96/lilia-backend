import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { User } from '@prisma/client';

import { DriversService } from './drivers.service';
import { VendorInvitationService } from '../vendors/vendor-invitation.service';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { PaginationQueryDto } from '../../common/pagination/pagination-query.dto';
import {
  CreateDriverDto,
  DeactivateDriverDto,
  DriverFilterDto,
  UpdateDriverDto,
  UpdateMyDriverProfileDto,
} from './dto/driver.dto';

/**
 * Gestion des livreurs — réservée à l'administration.
 *
 * `@Roles('ADMIN')` porte sur la **classe**, comme pour
 * `AdminVendorOnboardingController` : une route ajoutée ici est protégée par
 * défaut plutôt que de dépendre d'un décorateur qu'on aurait pu oublier.
 *
 * Ces routes n'existaient pas avant septembre 2026 : mettre un livreur en
 * service supposait un `PATCH /admin/users/:id/role` appelé à la main, depuis
 * un client HTTP, sur un compte que l'intéressé avait dû créer lui-même dans
 * l'application client. Aucune interface ne le faisait.
 */
@ApiTags('Drivers (admin)')
@ApiBearerAuth()
@Controller('admin/drivers')
@Roles('ADMIN')
export class AdminDriversController {
  constructor(
    private readonly drivers: DriversService,
    private readonly invitation: VendorInvitationService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Liste des livreurs, filtrable' })
  @ApiQuery({ name: 'search', required: false })
  @ApiQuery({ name: 'isActive', required: false, type: Boolean })
  @ApiQuery({ name: 'driverStatus', required: false })
  @ApiQuery({ name: 'statusUser', required: false })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  findAll(
    @Query() filter: DriverFilterDto,
    @Query() pagination: PaginationQueryDto,
  ) {
    return this.drivers.findAll(filter, pagination.page, pagination.limit);
  }

  @Get(':id')
  @ApiOperation({
    summary: "Fiche complète d'un livreur (compte, profil, activité)",
  })
  @ApiParam({ name: 'id', description: 'User.id du livreur' })
  findOne(@Param('id') id: string) {
    return this.drivers.findOne(id);
  }

  @Post()
  @Throttle({ short: { limit: 1, ttl: 1000 }, long: { limit: 20, ttl: 60000 } })
  @ApiOperation({
    summary: 'Créer un livreur — compte, profil métier et invitation',
    description:
      "Aucun mot de passe n'est choisi par l'administrateur : le compte naît " +
      'avec un secret jetable et le livreur définit le sien via un lien signé. ' +
      'Le profil naît inactif — activez-le une fois les documents vérifiés.',
  })
  async create(@Body() dto: CreateDriverDto, @CurrentUser() admin: User) {
    const created = await this.drivers.createDriver(dto, admin.id);
    // Envoi immédiat. Un échec ne fait pas échouer la création : l'admin
    // récupère le lien dans la réponse et peut le renvoyer depuis la fiche.
    const invitation = await this.invitation.sendForDriver(created.data.id);
    return { ...created, data: { ...created.data, invitation } };
  }

  @Patch(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Modifier le compte et le profil métier' })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateDriverDto,
    @CurrentUser() admin: User,
  ) {
    return this.drivers.updateDriver(id, dto, admin.id);
  }

  @Patch(':id/activate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mettre le livreur en service' })
  activate(@Param('id') id: string, @CurrentUser() admin: User) {
    return this.drivers.activate(id, admin.id);
  }

  @Patch(':id/deactivate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Retirer le livreur de la file d’assignation',
    description: 'Refusé tant qu’il a une course en cours.',
  })
  deactivate(
    @Param('id') id: string,
    @Body() dto: DeactivateDriverDto,
    @CurrentUser() admin: User,
  ) {
    return this.drivers.deactivate(id, dto, admin.id);
  }

  @Post(':id/resend-invitation')
  @HttpCode(HttpStatus.OK)
  @Throttle({
    short: { limit: 1, ttl: 60000 },
    long: { limit: 5, ttl: 3600000 },
  })
  @ApiOperation({ summary: "Renvoyer le lien d'activation au livreur" })
  async resendInvitation(@Param('id') id: string) {
    const result = await this.invitation.sendForDriver(id);
    return { data: result, message: 'Invitation renvoyée.' };
  }
}

/**
 * Ce que le livreur voit et modifie de lui-même.
 *
 * Séparé du contrôleur d'administration pour que `@Roles('LIVREUR')` porte sur
 * la classe entière, et parce que les deux périmètres n'ont pas la même
 * étendue : `UpdateMyDriverProfileDto` ne laisse pas toucher au véhicule, à la
 * plaque, au permis ni aux zones — ce sont des éléments vérifiés par
 * l'administration, et les laisser modifier viderait la vérification de son sens.
 */
@ApiTags('Drivers')
@ApiBearerAuth()
@Controller('drivers')
@Roles('LIVREUR')
export class DriversController {
  constructor(private readonly drivers: DriversService) {}

  @Get('me')
  @ApiOperation({
    summary: 'Mon profil livreur — compte, profil métier et disponibilité',
    description:
      'Rend les trois statuts séparément (`statusUser`, ' +
      '`driverProfile.isActive`, `driverStatus`). L’application les affiche ' +
      'tels quels : elle écrivait « Statut compte : Actif » en dur, y compris ' +
      'pour un compte suspendu.',
  })
  findMe(@CurrentUser() user: User) {
    return this.drivers.findMe(user.id);
  }

  @Patch('me')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Corriger mon nom, mon téléphone ou ma photo' })
  updateMe(@CurrentUser() user: User, @Body() dto: UpdateMyDriverProfileDto) {
    return this.drivers.updateMe(user.id, dto);
  }
}
