import { Module } from '@nestjs/common';
import { DeliveriesService } from './deliveries.service';
import { DeliveriesController } from './deliveries.controller';
import { PrismaModule } from '../../prisma/prisma.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { OrderStateMachine } from '../orders/order-state.machine';
import { PlatformSettingsModule } from '../platform-settings/platform-settings.module';

@Module({
  imports: [PrismaModule, NotificationsModule, PlatformSettingsModule],
  providers: [DeliveriesService, OrderStateMachine],
  controllers: [DeliveriesController],
  exports: [DeliveriesService],
})
export class DeliveriesModule {}
