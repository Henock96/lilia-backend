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

@Module({
  imports: [PrismaModule, NotificationsModule],
  controllers: [OrdersController],
  providers: [
    OrdersService,
    PaginationService,
    OrderStateMachine,
    StockService,
    OrderValidatorService,
    OrderCalculatorService,
  ],
})
export class OrdersModule {}
