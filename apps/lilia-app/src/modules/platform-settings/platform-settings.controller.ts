import { Body, Controller, Get, Patch } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles } from '../auth/decorators/roles.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { PlatformSettingsService } from './platform-settings.service';
import { UpdatePlatformSettingsDto } from './dto/update-platform-settings.dto';

/**
 * Paramètres publics nécessaires aux clients pour **estimer** un montant avant
 * checkout (frais de service, barème de fidélité).
 *
 * Les apps codaient ces valeurs en dur (8 % de commission, 1 pt = 5 XAF) : le
 * jour où l'admin change le taux, toutes les versions installées affichent
 * encore l'ancien — sans aucun signal. Le total facturé reste calculé par le
 * serveur au checkout ; cet endpoint ne sert qu'à l'affichage.
 */
@ApiTags('Platform Settings')
@Controller('platform-settings')
export class PublicPlatformSettingsController {
  constructor(private readonly service: PlatformSettingsService) {}

  @Public()
  @Get()
  @ApiOperation({ summary: 'Paramètres publics (estimation côté client)' })
  async get() {
    const settings = await this.service.getSettings();
    return {
      data: {
        serviceFeePercent: settings.serviceFeePercent,
        loyaltyPointsPer100Xaf: settings.loyaltyPointsPer100Xaf,
        loyaltyPointValueXaf: settings.loyaltyPointValueXaf,
        loyaltyMinRedemption: settings.loyaltyMinRedemption,
        maintenanceMode: settings.maintenanceMode,
        maintenanceMessage: settings.maintenanceMessage,
      },
    };
  }
}

/**
 * Configuration plateforme — ADMIN uniquement.
 * Guards globaux actifs (APP_GUARD) — pas de @UseGuards() nécessaire.
 */
@ApiTags('Platform Settings')
@ApiBearerAuth()
@Controller('admin/platform-settings')
@Roles('ADMIN')
export class PlatformSettingsController {
  constructor(private readonly service: PlatformSettingsService) {}

  @Get()
  @ApiOperation({ summary: 'Configuration plateforme' })
  async get() {
    return { data: await this.service.getSettings() };
  }

  @Patch()
  @ApiOperation({ summary: 'Mettre à jour la configuration plateforme' })
  async update(@Body() dto: UpdatePlatformSettingsDto) {
    return { data: await this.service.updateSettings(dto) };
  }
}
