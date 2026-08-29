import { Module } from '@nestjs/common';
import { OrdersService } from './orders.service';
import { OrderQueryService } from './order-query.service';
import { OrderCheckoutService } from './order-checkout.service';
import { OrderLifecycleService } from './order-lifecycle.service';
import { OrderReorderService } from './order-reorder.service';
import { OrderReceiptService } from './order-receipt.service';
import { OrdersController } from './orders.controller';
import { PrismaModule } from '../../prisma/prisma.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PaginationService } from '../../common/pagination/pagination.service';
import { OrderStateMachine } from './order-state.machine';
import { StockService } from './stock.service';
import { OrderValidatorService } from './order-validator.service';
import { OrderCalculatorService } from './order-calculator.service';
import { PromoService } from '../promo/promo.service';
import { TrackingModule } from '../tracking/tracking.module';
import { PlatformSettingsModule } from '../platform-settings/platform-settings.module';
import { VendorsModule } from '../vendors/vendors.module';
import { QuartiersModule } from '../quartiers/quartiers.module';
import { LoyaltyModule } from '../loyalty/loyalty.module';
import { RefundsModule } from '../refunds/refunds.module';

@Module({
  imports: [
    PrismaModule,
    NotificationsModule,
    TrackingModule,
    PlatformSettingsModule,
    VendorsModule,
    QuartiersModule,
    LoyaltyModule,
    RefundsModule,
  ],
  controllers: [OrdersController],
  providers: [
    OrdersService,
    OrderQueryService,
    OrderCheckoutService,
    OrderLifecycleService,
    OrderReorderService,
    PaginationService,
    OrderStateMachine,
    StockService,
    OrderValidatorService,
    OrderCalculatorService,
    PromoService,
    OrderReceiptService,
  ],
  // `OrderExpiryService` (module schedule) réutilise le chemin d'annulation
  // avec ses compensations plutôt que de le réimplémenter.
  exports: [OrderLifecycleService],
})
export class OrdersModule {}
