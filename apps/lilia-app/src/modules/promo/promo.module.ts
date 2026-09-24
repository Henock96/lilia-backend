import { Module } from '@nestjs/common';
import { PromoController } from './promo.controller';
import { PromoService } from './promo.service';
import { DeliveryPricingCoreModule } from '../delivery-pricing/delivery-pricing-core.module';

@Module({
  imports: [DeliveryPricingCoreModule],
  controllers: [PromoController],
  providers: [PromoService],
  exports: [PromoService],
})
export class PromoModule {}
