import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { DeliveryPricingCoreModule } from './delivery-pricing-core.module';
import { DeliveryTariffsService } from './delivery-tariffs.service';
import { AdminDeliveryTariffsController } from './admin-delivery-tariffs.controller';
import { DeliveryTariffsController } from './delivery-tariffs.controller';
import { PlatformSettingsCoreModule } from '../platform-settings/platform-settings-core.module';

/**
 * Administration de la grille de livraison (F3-02). Porte un controller :
 * réservé au processus web, jamais importé par le worker (qui n'a que le
 * module core).
 */
@Module({
  imports: [
    PrismaModule,
    DeliveryPricingCoreModule,
    PlatformSettingsCoreModule,
  ],
  controllers: [AdminDeliveryTariffsController, DeliveryTariffsController],
  providers: [DeliveryTariffsService],
})
export class DeliveryPricingModule {}
