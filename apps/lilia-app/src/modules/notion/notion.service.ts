import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { Queue } from 'bullmq';
import {
  BackfillJob,
  SyncIncidentJob,
  SyncOrderJob,
  SyncRestaurantJob,
} from './interfaces/notion-job.types';
import { NOTION_JOBS, NOTION_QUEUE } from './notion.constants';

/**
 * Façade publique du module Notion.
 * Les autres modules (listeners, controller, autres services) appellent uniquement
 * cette interface — jamais le NotionClient ni les sync services directement.
 */
@Injectable()
export class NotionService {
  private readonly logger = new Logger(NotionService.name);

  constructor(@InjectQueue(NOTION_QUEUE) private readonly queue: Queue) {}

  async enqueueOrderSync(payload: SyncOrderJob): Promise<void> {
    await this.queue.add(NOTION_JOBS.SYNC_ORDER, payload, {
      jobId: `order:${payload.orderId}`, // dedupe — un seul job pending par order
      removeOnComplete: 100,
      removeOnFail: 500,
      attempts: 5,
      backoff: { type: 'exponential', delay: 2000 },
    });
  }

  async enqueueRestaurantSync(payload: SyncRestaurantJob): Promise<void> {
    await this.queue.add(NOTION_JOBS.SYNC_RESTAURANT, payload, {
      jobId: `restaurant:${payload.restaurantId}`,
      removeOnComplete: 100,
      removeOnFail: 500,
      attempts: 5,
      backoff: { type: 'exponential', delay: 2000 },
    });
  }

  async enqueueIncidentSync(payload: SyncIncidentJob): Promise<void> {
    await this.queue.add(NOTION_JOBS.SYNC_INCIDENT, payload, {
      jobId: `incident:${payload.incidentId}`,
      removeOnComplete: 100,
      removeOnFail: 500,
      attempts: 5,
      backoff: { type: 'exponential', delay: 2000 },
    });
  }

  async enqueueBackfill(
    type: 'orders' | 'restaurants' | 'incidents',
    payload: BackfillJob = {},
  ): Promise<void> {
    const jobName =
      type === 'orders'
        ? NOTION_JOBS.BACKFILL_ORDERS
        : type === 'restaurants'
          ? NOTION_JOBS.BACKFILL_RESTAURANTS
          : NOTION_JOBS.BACKFILL_INCIDENTS;

    await this.queue.add(jobName, payload, {
      removeOnComplete: 10,
      removeOnFail: 100,
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
    });
    this.logger.log(`Backfill ${type} enqueued`);
  }

  async getQueueStats() {
    const [waiting, active, completed, failed, delayed] = await Promise.all([
      this.queue.getWaitingCount(),
      this.queue.getActiveCount(),
      this.queue.getCompletedCount(),
      this.queue.getFailedCount(),
      this.queue.getDelayedCount(),
    ]);
    return { waiting, active, completed, failed, delayed };
  }
}
