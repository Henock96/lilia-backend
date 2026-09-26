import { Module } from '@nestjs/common';
import { CartModule } from '../cart/cart.module';
import { OrdersService } from './orders.service';
import { OrderQueryService } from './order-query.service';
import { OrderCheckoutService } from './order-checkout.service';
import { OrderReorderService } from './order-reorder.service';
import { OrderReceiptService } from './order-receipt.service';
import { OrdersController } from './orders.controller';
import { PrismaModule } from '../../prisma/prisma.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PaginationService } from '../../common/pagination/pagination.service';
import { OrderValidatorService } from './order-validator.service';
import { OrderCalculatorService } from './order-calculator.service';
import { DeliveryDestinationService } from './delivery-destination.service';
import { PromoService } from '../promo/promo.service';
import { TrackingModule } from '../tracking/tracking.module';
import { PlatformSettingsModule } from '../platform-settings/platform-settings.module';
import { VendorsModule } from '../vendors/vendors.module';
import { QuartiersModule } from '../quartiers/quartiers.module';
import { OrdersCoreModule } from './orders-core.module';
import { DeliveryPricingCoreModule } from '../delivery-pricing/delivery-pricing-core.module';
import { VendorOpeningService } from '../vendors/vendor-opening.service';
import { VendorOffersCoreModule } from '../vendor-offers/vendor-offers-core.module';

@Module({
  imports: [
    PrismaModule,
    NotificationsModule,
    TrackingModule,
    PlatformSettingsModule,
    VendorsModule,
    QuartiersModule,
    OrdersCoreModule,
    DeliveryPricingCoreModule,
    // F3-10 — le reorder rachète un menu par le chemin de `POST /cart/menus`.
    CartModule,
    // F3-11 — offre boutique au checkout et au devis.
    VendorOffersCoreModule,
  ],
  controllers: [OrdersController],
  providers: [
    OrdersService,
    OrderQueryService,
    OrderCheckoutService,
    OrderReorderService,
    PaginationService,
    OrderValidatorService,
    // F3-03 : le checkout recalcule l'ouverture (même règle que le cron).
    VendorOpeningService,
    OrderCalculatorService,
    DeliveryDestinationService,
    PromoService,
    OrderReceiptService,
  ],
  // `OrderExpiryService` (module schedule) réutilise le chemin d'annulation
  // avec ses compensations plutôt que de le réimplémenter.
  exports: [OrdersCoreModule],
})
export class OrdersModule {}
