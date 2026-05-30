/* eslint-disable prettier/prettier */
import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { RestaurantScheduleService } from './restaurant-schedule.service';
import { PreorderReminderService } from './preorder-reminder.service';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
    imports: [ScheduleModule.forRoot(), NotificationsModule],
    providers: [
        RestaurantScheduleService,
        PreorderReminderService,
        PrismaService,
    ],
})
export class AppScheduleModule {}
