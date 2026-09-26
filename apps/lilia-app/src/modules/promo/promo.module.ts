import { PlatformSettingsCoreModule } from '../platform-settings/platform-settings-core.module';
import { Module } from '@nestjs/common';
import { PromoController } from './promo.controller';
import { PromoService } from './promo.service';
import { DeliveryPricingCoreModule } from '../delivery-pricing/delivery-pricing-core.module';
import { VendorOffersCoreModule } from '../vendor-offers/vendor-offers-core.module';

@Module({
  imports: [
    DeliveryPricingCoreModule,
    PlatformSettingsCoreModule,
    VendorOffersCoreModule,
  ],
  controllers: [PromoController],
  providers: [PromoService],
  exports: [PromoService],
})
export class PromoModule {}
