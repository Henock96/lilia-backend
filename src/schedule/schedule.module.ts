/* eslint-disable prettier/prettier */
import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { RestaurantScheduleService } from './restaurant-schedule.service';
import { PrismaService } from 'src/prisma/prisma.service';

@Module({
    imports: [ScheduleModule.forRoot()],
    providers: [RestaurantScheduleService, PrismaService],
})
export class AppScheduleModule {}
