import { NOTION_JOBS } from '../notion.constants';

export interface SyncOrderJob {
  orderId: string;
  reason: 'created' | 'status.updated' | 'cancelled' | 'manual';
}

export interface SyncRestaurantJob {
  restaurantId: string;
  reason: 'created' | 'updated' | 'manual';
}

export interface SyncIncidentJob {
  incidentId: string;
  reason: 'created' | 'updated' | 'manual';
}

export interface BackfillJob {
  /** Limite optionnelle pour ne pas pousser toute la base en une fois. */
  limit?: number;
  /** Cursor cuid du dernier ID traité pour pagination. */
  cursor?: string;
}

export type NotionJobPayload =
  | { name: typeof NOTION_JOBS.SYNC_ORDER; data: SyncOrderJob }
  | { name: typeof NOTION_JOBS.SYNC_RESTAURANT; data: SyncRestaurantJob }
  | { name: typeof NOTION_JOBS.SYNC_INCIDENT; data: SyncIncidentJob }
  | { name: typeof NOTION_JOBS.BACKFILL_ORDERS; data: BackfillJob }
  | { name: typeof NOTION_JOBS.BACKFILL_RESTAURANTS; data: BackfillJob }
  | { name: typeof NOTION_JOBS.BACKFILL_INCIDENTS; data: BackfillJob };
