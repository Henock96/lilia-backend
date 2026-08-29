import { Global, Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { SmsModule } from '../sms/sms.module';
import { OutboxService } from './outbox.service';
import { OutboxDispatcherService } from './outbox-dispatcher.service';
import { CronLockService } from '../../common/locks/cron-lock.service';

/**
 * Boîte d'envoi transactionnelle + son worker (fix H7).
 *
 * Global : `OutboxService` est écrit depuis la transaction de checkout et
 * acquitté depuis les listeners, qui sont des providers du module racine.
 * `CronLockService` est exporté ici car il sert aussi aux crons du module
 * `schedule` (fix M8).
 */
@Global()
@Module({
  imports: [PrismaModule, NotificationsModule, SmsModule],
  providers: [OutboxService, OutboxDispatcherService, CronLockService],
  exports: [OutboxService, CronLockService],
})
export class OutboxModule {}
