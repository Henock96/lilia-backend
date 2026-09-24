import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { PlatformSettingsCoreModule } from '../platform-settings/platform-settings-core.module';
import { DeliveryPricingService } from './delivery-pricing.service';
import { DeliverySimulationService } from './delivery-simulation.service';

/**
 * Tarification de la livraison (F3-02), **sans controller** : le checkout et
 * le devis public en ont besoin, et un module core ne doit jamais monter de
 * route (cf. `worker.module.spec.ts`).
 */
@Module({
  imports: [PrismaModule, PlatformSettingsCoreModule],
  providers: [DeliveryPricingService, DeliverySimulationService],
  exports: [DeliveryPricingService, DeliverySimulationService],
})
export class DeliveryPricingCoreModule {}
