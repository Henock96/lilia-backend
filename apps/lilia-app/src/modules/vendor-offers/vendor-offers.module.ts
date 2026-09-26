import { Module } from '@nestjs/common';

import {
  AdminVendorOffersController,
  VendorOffersController,
} from './vendor-offers.controller';
import { VendorOffersCoreModule } from './vendor-offers-core.module';

/** Routes des offres boutique (F3-11). Le service vit dans le module « core ». */
@Module({
  imports: [VendorOffersCoreModule],
  controllers: [VendorOffersController, AdminVendorOffersController],
})
export class VendorOffersModule {}
