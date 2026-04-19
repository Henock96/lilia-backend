import { Module } from '@nestjs/common';
import { OrdersService } from './orders.service';
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

@Module({
  imports: [PrismaModule, NotificationsModule, TrackingModule],
  controllers: [OrdersController],
  providers: [
    OrdersService,
    PaginationService,
    OrderStateMachine,
    StockService,
    OrderValidatorService,
    OrderCalculatorService,
    PromoService,
  ],
})
export class OrdersModule {}
