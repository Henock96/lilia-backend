import { Injectable, Logger } from '@nestjs/common';
import { NotionClient } from './notion.client';
import { NotionConfig } from './notion.config';
import { NotionService } from './notion.service';

export interface NotionHealthReport {
  enabled: boolean;
  apiReachable: boolean;
  databases: {
    orders: boolean;
    restaurants: boolean;
    incidents: boolean;
  };
  queue: {
    waiting: number;
    active: number;
    completed: number;
    failed: number;
    delayed: number;
  };
  error?: string;
}

@Injectable()
export class NotionHealthService {
  private readonly logger = new Logger(NotionHealthService.name);

  constructor(
    private readonly notionConfig: NotionConfig,
    private readonly notionClient: NotionClient,
    private readonly notionService: NotionService,
  ) {}

  async check(): Promise<NotionHealthReport> {
    const enabled = this.notionConfig.isEnabled;
    const dbIds = this.notionConfig.getAllDbIds();
    const queue = await this.notionService.getQueueStats();

    if (!enabled) {
      return {
        enabled: false,
        apiReachable: false,
        databases: { orders: false, restaurants: false, incidents: false },
        queue,
      };
    }

    try {
      // ping rapide : récupère l'utilisateur de l'integration
      await this.notionClient.exec('healthcheck', (c) => c.users.me({}), 1);
      return {
        enabled,
        apiReachable: true,
        databases: {
          orders: !!dbIds.orders,
          restaurants: !!dbIds.restaurants,
          incidents: !!dbIds.incidents,
        },
        queue,
      };
    } catch (e) {
      return {
        enabled,
        apiReachable: false,
        databases: {
          orders: !!dbIds.orders,
          restaurants: !!dbIds.restaurants,
          incidents: !!dbIds.incidents,
        },
        queue,
        error: (e as Error).message,
      };
    }
  }
}
