import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import {
  BackfillJob,
  SyncIncidentJob,
  SyncOrderJob,
  SyncRestaurantJob,
} from '../interfaces/notion-job.types';
import { NOTION_JOBS, NOTION_QUEUE } from '../notion.constants';
import { IncidentsSyncService } from '../sync/incidents-sync.service';
import { OrdersSyncService } from '../sync/orders-sync.service';
import { RestaurantsSyncService } from '../sync/restaurants-sync.service';

/**
 * Worker BullMQ qui consomme la queue notion-sync.
 *
 * Toutes les écritures vers Notion passent par ici → garantit :
 *   - Retry automatique (config BullMQ + retry interne du NotionClient)
 *   - Pas de latence ajoutée sur les routes API
 *   - Observabilité centralisée (logs + queue stats)
 */
@Processor(NOTION_QUEUE, { concurrency: 2 })
export class NotionSyncProcessor extends WorkerHost {
  private readonly logger = new Logger(NotionSyncProcessor.name);

  constructor(
    private readonly ordersSync: OrdersSyncService,
    private readonly restaurantsSync: RestaurantsSyncService,
    private readonly incidentsSync: IncidentsSyncService,
  ) {
    super();
  }

  async process(job: Job): Promise<unknown> {
    this.logger.log(`Job ${job.name}#${job.id} start`);
    switch (job.name) {
      case NOTION_JOBS.SYNC_ORDER: {
        const data = job.data as SyncOrderJob;
        await this.ordersSync.syncOne(data.orderId);
        return { ok: true };
      }
      case NOTION_JOBS.SYNC_RESTAURANT: {
        const data = job.data as SyncRestaurantJob;
        await this.restaurantsSync.syncOne(data.restaurantId);
        return { ok: true };
      }
      case NOTION_JOBS.SYNC_INCIDENT: {
        const data = job.data as SyncIncidentJob;
        await this.incidentsSync.syncOne(data.incidentId);
        return { ok: true };
      }
      case NOTION_JOBS.BACKFILL_ORDERS: {
        const data = job.data as BackfillJob;
        return this.ordersSync.backfill(data.limit, data.cursor);
      }
      case NOTION_JOBS.BACKFILL_RESTAURANTS: {
        const data = job.data as BackfillJob;
        return this.restaurantsSync.backfill(data.limit, data.cursor);
      }
      case NOTION_JOBS.BACKFILL_INCIDENTS: {
        const data = job.data as BackfillJob;
        return this.incidentsSync.backfill(data.limit, data.cursor);
      }
      default:
        this.logger.warn(`Job inconnu: ${job.name}`);
        return { ok: false, reason: 'unknown_job' };
    }
  }
}
