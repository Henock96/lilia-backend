import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { IncidentsController } from './incidents.controller';
import { IncidentsListener } from './incidents.listener';
import { IncidentsNotificationListener } from './incidents-notification.listener';
import { IncidentsService } from './incidents.service';

@Module({
  imports: [PrismaModule, NotificationsModule],
  controllers: [IncidentsController],
  providers: [IncidentsService, IncidentsListener, IncidentsNotificationListener],
  exports: [IncidentsService],
})
export class IncidentsModule {}
