import { Module } from '@nestjs/common';
import { PlatformSettingsCoreModule } from './platform-settings-core.module';
import { DeliveryPricingCoreModule } from '../delivery-pricing/delivery-pricing-core.module';
import {
  PlatformSettingsController,
  PublicPlatformSettingsController,
} from './platform-settings.controller';

/**
 * Ajoute l'exposition HTTP au service porté par `PlatformSettingsCoreModule`.
 * Un consommateur qui veut seulement *lire* les réglages importe le core.
 */
@Module({
  // Le plancher public de la grille (« livraison dès X ») est servi par la
  // route publique des réglages (F3-02).
  imports: [PlatformSettingsCoreModule, DeliveryPricingCoreModule],
  controllers: [PublicPlatformSettingsController, PlatformSettingsController],
  exports: [PlatformSettingsCoreModule],
})
export class PlatformSettingsModule {}
