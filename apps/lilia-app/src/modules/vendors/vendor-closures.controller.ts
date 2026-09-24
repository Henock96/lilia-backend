import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { User } from '@prisma/client';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RestaurantAccessService } from '../restaurants/restaurant-access.service';
import {
  CreatePublicHolidayDto,
  CreateVendorClosureDto,
  PauseVendorDto,
  UpdateClosedOnHolidaysDto,
} from './dto/vendor-closures.dto';
import { VendorClosuresService } from './vendor-closures.service';
import { PublicHolidaysService } from './public-holidays.service';

/**
 * Fermetures datées d'un vendeur (F3-03) — propriétaire ou admin.
 *
 * Même porte que les autres réglages de boutique (`/vendors/:id/...` +
 * `verifyOwnership`) : un vendeur ne peut mettre en pause que sa boutique.
 */
@ApiTags('Vendor closures')
@ApiBearerAuth()
@Controller('vendors')
@Roles('ADMIN', 'RESTAURATEUR')
export class VendorClosuresController {
  constructor(
    private readonly access: RestaurantAccessService,
    private readonly closures: VendorClosuresService,
  ) {}

  @Get(':id/opening')
  @ApiOperation({ summary: 'État d’ouverture, pause et congés (gestionnaire)' })
  async opening(@Param('id') id: string, @CurrentUser() caller: User) {
    await this.access.verifyOwnership(id, caller.firebaseUid);
    return { data: await this.closures.openingState(id) };
  }

  @Post(':id/pause')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mettre la boutique en pause (7 jours au plus)' })
  async pause(
    @Param('id') id: string,
    @Body() dto: PauseVendorDto,
    @CurrentUser() caller: User,
  ) {
    await this.access.verifyOwnership(id, caller.firebaseUid);
    return { data: await this.closures.pause(id, dto, caller) };
  }

  @Delete(':id/pause')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Lever la pause (rouvrir maintenant)' })
  async resume(@Param('id') id: string, @CurrentUser() caller: User) {
    await this.access.verifyOwnership(id, caller.firebaseUid);
    return { data: await this.closures.resume(id) };
  }

  @Get(':id/closures')
  @ApiOperation({ summary: 'Congés en cours et à venir' })
  async list(@Param('id') id: string, @CurrentUser() caller: User) {
    await this.access.verifyOwnership(id, caller.firebaseUid);
    return { data: await this.closures.listClosures(id) };
  }

  @Post(':id/closures')
  @ApiOperation({ summary: 'Déclarer un congé' })
  async create(
    @Param('id') id: string,
    @Body() dto: CreateVendorClosureDto,
    @CurrentUser() caller: User,
  ) {
    await this.access.verifyOwnership(id, caller.firebaseUid);
    return { data: await this.closures.addClosure(id, dto, caller.id) };
  }

  @Delete(':id/closures/:closureId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Supprimer un congé' })
  async remove(
    @Param('id') id: string,
    @Param('closureId') closureId: string,
    @CurrentUser() caller: User,
  ) {
    await this.access.verifyOwnership(id, caller.firebaseUid);
    return { data: await this.closures.removeClosure(id, closureId) };
  }

  @Patch(':id/closed-on-holidays')
  @ApiOperation({ summary: 'Fermé les jours fériés (oui / non)' })
  async closedOnHolidays(
    @Param('id') id: string,
    @Body() dto: UpdateClosedOnHolidaysDto,
    @CurrentUser() caller: User,
  ) {
    await this.access.verifyOwnership(id, caller.firebaseUid);
    return {
      data: await this.closures.setClosedOnHolidays(id, dto.closedOnHolidays),
    };
  }
}

/** Calendrier des jours fériés (F3-03) — ADMIN. */
@ApiTags('Vendor closures')
@ApiBearerAuth()
@Controller('admin/public-holidays')
@Roles('ADMIN')
export class AdminPublicHolidaysController {
  constructor(private readonly holidays: PublicHolidaysService) {}

  @Get()
  async list() {
    return { data: await this.holidays.list() };
  }

  @Post()
  async create(
    @Body() dto: CreatePublicHolidayDto,
    @CurrentUser() admin: User,
  ) {
    return { data: await this.holidays.create(dto.date, dto.label, admin.id) };
  }

  @Delete(':date')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param('date') date: string, @CurrentUser() admin: User) {
    await this.holidays.remove(date, admin.id);
  }
}
