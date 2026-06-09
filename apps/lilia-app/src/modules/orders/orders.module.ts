import { Module } from '@nestjs/common';
import { OrdersService } from './orders.service';
import { OrderQueryService } from './order-query.service';
import { OrderCheckoutService } from './order-checkout.service';
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

@Module({
  imports: [PrismaModule, NotificationsModule, TrackingModule, PlatformSettingsModule, VendorsModule, QuartiersModule],
  controllers: [OrdersController],
  providers: [
    OrdersService,
    OrderQueryService,
    OrderCheckoutService,
    PaginationService,
    OrderStateMachine,
    StockService,
    OrderValidatorService,
    OrderCalculatorService,
    PromoService,
  ],
})
export class OrdersModule {}
