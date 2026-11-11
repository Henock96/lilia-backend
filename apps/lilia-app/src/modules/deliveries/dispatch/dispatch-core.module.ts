import { Module } from '@nestjs/common';

import { PrismaModule } from '../../../prisma/prisma.module';
import { NotificationsCoreModule } from '../../notifications/notifications-core.module';
import { DeliveryDispatchService } from './delivery-dispatch.service';

/**
 * Dispatch FCFS (10/11/2026).
 *
 * ⚠️ Chargé par le web ET par le worker, composé de modules « core » : aucun
 * controller ne se monte. `OutboxModule` (global) fournit le dispatcher et
 * `CronLockService`. Importé par `OrdersModule` (ouverture à PRET),
 * `DeliveriesModule` (claim, liste, supervision) et `WorkerModule` (tours et
 * reprise outbox) : une seule instance par processus.
 */
@Module({
  imports: [PrismaModule, NotificationsCoreModule],
  providers: [DeliveryDispatchService],
  exports: [DeliveryDispatchService],
})
export class DispatchCoreModule {}
