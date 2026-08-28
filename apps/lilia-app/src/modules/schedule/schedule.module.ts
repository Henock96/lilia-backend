/* eslint-disable prettier/prettier */
import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { RestaurantScheduleService } from './restaurant-schedule.service';
import { PreorderReminderService } from './preorder-reminder.service';
import { OrderExpiryService } from './order-expiry.service';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationsModule } from '../notifications/notifications.module';
import { OrdersModule } from '../orders/orders.module';

@Module({
    imports: [ScheduleModule.forRoot(), NotificationsModule, OrdersModule],
    providers: [
        RestaurantScheduleService,
        PreorderReminderService,
        OrderExpiryService,
        PrismaService,
    ],
})
export class AppScheduleModule {}
