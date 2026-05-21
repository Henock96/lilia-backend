import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import {
  IncidentCreatedEvent,
  IncidentUpdatedEvent,
} from '../../incidents/incidents.service';
import {
  OrderCancelledEvent,
  OrderCreatedEvent,
  OrderPaymentConfirmedEvent,
  OrderStatusUpdatedEvent,
} from '../../events/order-events';
import { NotionConfig } from '../notion.config';
import { NotionService } from '../notion.service';

/**
 * Pont EventEmitter2 → BullMQ.
 *
 * Aucun travail Notion ici — uniquement enqueue. Les sync services tournent
 * dans le worker BullMQ, isolés des routes API.
 */
@Injectable()
export class NotionListener {
  private readonly logger = new Logger(NotionListener.name);

  constructor(
    private readonly notion: NotionService,
    private readonly notionConfig: NotionConfig,
  ) {}

  private get enabled(): boolean {
    if (!this.notionConfig.isEnabled) return false;
    return true;
  }

  // ============ Orders ============
  @OnEvent('order.created')
  async onOrderCreated(event: OrderCreatedEvent) {
    if (!this.enabled) return;
    await this.notion.enqueueOrderSync({
      orderId: event.orderId,
      reason: 'created',
    });
  }

  @OnEvent('order.status.updated')
  async onOrderStatusUpdated(event: OrderStatusUpdatedEvent) {
    if (!this.enabled) return;
    await this.notion.enqueueOrderSync({
      orderId: event.orderId,
      reason: 'status.updated',
    });
  }

  @OnEvent('order.cancelled')
  async onOrderCancelled(event: OrderCancelledEvent) {
    if (!this.enabled) return;
    await this.notion.enqueueOrderSync({
      orderId: event.orderId,
      reason: 'cancelled',
    });
  }

  @OnEvent('order.payment.confirmed')
  async onPaymentConfirmed(event: OrderPaymentConfirmedEvent) {
    if (!this.enabled) return;
    await this.notion.enqueueOrderSync({
      orderId: event.orderId,
      reason: 'status.updated',
    });
  }

  // ============ Incidents ============
  @OnEvent('incident.created')
  async onIncidentCreated(event: IncidentCreatedEvent) {
    if (!this.enabled) return;
    await this.notion.enqueueIncidentSync({
      incidentId: event.incidentId,
      reason: 'created',
    });
  }

  @OnEvent('incident.updated')
  async onIncidentUpdated(event: IncidentUpdatedEvent) {
    if (!this.enabled) return;
    await this.notion.enqueueIncidentSync({
      incidentId: event.incidentId,
      reason: 'updated',
    });
  }

  // ============ Restaurants ============
  // Note: il n'y a pas (encore) d'event restaurant.created/updated dans le projet.
  // Les sync se déclenchent via l'endpoint manuel POST /notion/sync/restaurant/:id
  // ou le backfill quotidien.
}
