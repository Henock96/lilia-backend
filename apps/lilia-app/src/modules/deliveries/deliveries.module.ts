import { Module } from '@nestjs/common';
import { DeliveriesService } from './deliveries.service';
import { DeliveriesController } from './deliveries.controller';
import { PrismaModule } from '../../prisma/prisma.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { OrderStateMachine } from '../orders/order-state.machine';

@Module({
  imports: [PrismaModule, NotificationsModule],
  providers: [DeliveriesService, OrderStateMachine],
  controllers: [DeliveriesController],
  exports: [DeliveriesService],
})
export class DeliveriesModule {}
