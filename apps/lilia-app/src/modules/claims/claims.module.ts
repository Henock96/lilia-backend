import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { NotificationsCoreModule } from '../notifications/notifications-core.module';
import { ClaimsController } from './claims.controller';
import { ClaimsNotificationListener } from './claims-notification.listener';
import { ClaimsService } from './claims.service';

/**
 * Réclamations client (F3-06). Module **web** (il déclare un controller) :
 * il ne doit jamais entrer dans le graphe du worker.
 */
@Module({
  imports: [PrismaModule, NotificationsCoreModule],
  controllers: [ClaimsController],
  providers: [ClaimsService, ClaimsNotificationListener],
})
export class ClaimsModule {}
