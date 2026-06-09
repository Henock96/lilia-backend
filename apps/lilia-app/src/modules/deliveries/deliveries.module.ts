import { Module } from '@nestjs/common';
import { DeliveriesService } from './deliveries.service';
import { DeliveryQueryService } from './delivery-query.service';
import { DeliveriesController } from './deliveries.controller';
import { PrismaModule } from '../../prisma/prisma.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { OrderStateMachine } from '../orders/order-state.machine';
import { PlatformSettingsModule } from '../platform-settings/platform-settings.module';
import { TrackingModule } from '../tracking/tracking.module';

@Module({
  imports: [PrismaModule, NotificationsModule, PlatformSettingsModule, TrackingModule],
  providers: [DeliveriesService, DeliveryQueryService, OrderStateMachine],
  controllers: [DeliveriesController],
  exports: [DeliveriesService],
})
export class DeliveriesModule {}
