import { Body, Controller, Get, Patch } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles } from '../auth/decorators/roles.decorator';
import { PlatformSettingsService } from './platform-settings.service';
import { UpdatePlatformSettingsDto } from './dto/update-platform-settings.dto';

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
