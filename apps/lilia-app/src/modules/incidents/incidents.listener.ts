import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { IncidentSeverity, IncidentType } from '@prisma/client';
import { OrderCancelledEvent } from '../events/order-events';
import { IncidentsService } from './incidents.service';

@Injectable()
export class IncidentsListener {
  private readonly logger = new Logger(IncidentsListener.name);

  constructor(private readonly incidents: IncidentsService) {}

  @OnEvent('order.cancelled')
  async onOrderCancelled(event: OrderCancelledEvent) {
    try {
      await this.incidents.create({
        type: IncidentType.ORDER_CANCELLED,
        severity: event.refundAmount && event.refundAmount > 0
          ? IncidentSeverity.HIGH
          : IncidentSeverity.LOW,
        title: `Commande annulée #${event.orderId.slice(-6)}`,
        description:
          event.cancelReason ??
          'Commande annulée — aucune raison fournie par l\'utilisateur.',
        orderId: event.orderId,
        restaurantId: event.restaurantId,
        metadata: {
          cancelledBy: event.cancelledBy,
          refundAmount: event.refundAmount ?? 0,
          userId: event.userId,
        },
      });
    } catch (error) {
      this.logger.error(
        `Erreur création incident depuis order.cancelled (${event.orderId}): ${(error as Error).message}`,
      );
    }
  }
}
