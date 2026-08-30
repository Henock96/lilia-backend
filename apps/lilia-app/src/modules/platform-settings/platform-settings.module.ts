import { Module } from '@nestjs/common';
import { PlatformSettingsCoreModule } from './platform-settings-core.module';
import {
  PlatformSettingsController,
  PublicPlatformSettingsController,
} from './platform-settings.controller';

/**
 * Ajoute l'exposition HTTP au service porté par `PlatformSettingsCoreModule`.
 * Un consommateur qui veut seulement *lire* les réglages importe le core.
 */
@Module({
  imports: [PlatformSettingsCoreModule],
  controllers: [PublicPlatformSettingsController, PlatformSettingsController],
  exports: [PlatformSettingsCoreModule],
})
export class PlatformSettingsModule {}
