import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { OpsController } from './ops.controller';
import { OpsQueueService } from './ops-queue.service';

/**
 * Cockpit ops (F3-04), côté web : la route de lecture. Le scan d'alerte vit
 * dans `AppScheduleModule` (cron, worker) et n'importe pas ce module, qui
 * monterait `/admin/ops/queue` sans garde sur le port du worker.
 */
@Module({
  imports: [PrismaModule],
  controllers: [OpsController],
  providers: [OpsQueueService],
})
export class OpsModule {}
