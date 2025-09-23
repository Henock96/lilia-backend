/* eslint-disable prettier/prettier */
import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { OrderCreatedEvent, OrderStatusUpdatedEvent, OrderCancelledEvent } from '../events/order-events';
import { OrderStatus } from '@prisma/client';

@Injectable()
export class OrdersListener {
  private readonly logger = new Logger(OrdersListener.name);

  constructor(
    private readonly notificationsService: NotificationsService,
    private readonly prisma: PrismaService,
  ) {}


  // ===== CRÉATION DE COMMANDE =====
  @OnEvent('order.created')
  async handleOrderCreated(event: OrderCreatedEvent) {
    this.logger.log(`Handling order created event: ${event.orderId}`);

    try {
      // 1. Notification au client
      await this.notifyCustomerOrderCreated(event);

      // 2. Notification au restaurateur
      await this.notifyRestaurantNewOrder(event);


      this.logger.log(`Notifications de création de commande envoyées pour: ${event.orderId}`);
    } catch (error) {
      this.logger.error(`Erreur lors de la gestion de l'événement de création de commande: ${error.message}`, error.stack);
    }
  }

  // ===== MISE À JOUR DE STATUT =====
  @OnEvent('order.status.updated')
  async handleOrderStatusUpdated(event: OrderStatusUpdatedEvent) {
    this.logger.log(
      `Mise à jour du statut de la commande de traitement: ${event.orderId} (${event.previousStatus} -> ${event.newStatus})`
    );

    try {
      // 1. Notification au client
      await this.notifyCustomerStatusUpdate(event);

      // 2. Notification au restaurateur (si nécessaire)
      if (this.shouldNotifyRestaurantOfStatusUpdate(event.newStatus)) {
        await this.notifyRestaurantStatusUpdate(event);
      }

      this.logger.log(`Order status update notifications sent for: ${event.orderId}`);
    } catch (error) {
      this.logger.error(`Error handling order status update event: ${error.message}`, error.stack);
    }
  }

  // ===== ANNULATION DE COMMANDE =====
  @OnEvent('order.cancelled')
  async handleOrderCancelled(event: OrderCancelledEvent) {
    this.logger.log(`Handling order cancelled event: ${event.orderId}`);

    try {
      // 1. Notification au client
      await this.notifyCustomerOrderCancelled(event);

      // 2. Notification au restaurateur
      await this.notifyRestaurantOrderCancelled(event);

      

      this.logger.log(`Order cancelled notifications sent for: ${event.orderId}`);
    } catch (error) {
      this.logger.error(`Error handling order cancelled event: ${error.message}`, error.stack);
    }
  }

  // ===== MÉTHODES PRIVÉES POUR NOTIFICATIONS =====

  private async notifyCustomerOrderCreated(event: OrderCreatedEvent) {
    const title = '🎉 Commande confirmée !';
    const body = `Votre commande chez ${event.orderData.restaurantName} a été reçue. Montant: ${event.orderData.totalAmount} FCFA`;

    await this.notificationsService.sendPushNotification(
      event.userId,
      title,
      body,
      {
        orderId: event.orderId,
        type: 'order_created',
        restaurantId: event.restaurantId,
      },
    );
  }

  private async notifyRestaurantNewOrder(event: OrderCreatedEvent) {
    // Récupérer l'owner du restaurant
    const restaurant = await this.prisma.restaurant.findUnique({
      where: { id: event.restaurantId },
      select: { ownerId: true },
    });

    if (restaurant) {
      const title = '🔔 Nouvelle commande !';
      const body = `Nouvelle commande de ${event.orderData.totalAmount} FCFA (${event.orderData.itemCount} articles)`;

      await this.notificationsService.sendPushNotification(
        restaurant.ownerId,
        title,
        body,
        {
          orderId: event.orderId,
          type: 'new_order',
          customerId: event.userId,
        },
      );
    }
  }

  private async notifyCustomerStatusUpdate(event: OrderStatusUpdatedEvent) {
    const { title, body } = this.getStatusUpdateMessage(event.newStatus, event.orderData.restaurantName);

    await this.notificationsService.sendPushNotification(
      event.userId,
      title,
      body,
      {
        orderId: event.orderId,
        type: 'status_update',
        status: event.newStatus,
        restaurantId: event.restaurantId,
      },
    );
  }

  private async notifyRestaurantStatusUpdate(event: OrderStatusUpdatedEvent) {
    const restaurant = await this.prisma.restaurant.findUnique({
      where: { id: event.restaurantId },
      select: { ownerId: true },
    });

    if (restaurant) {
      const title = '📋 Statut de commande mis à jour';
      const body = `Commande ${event.orderId.substring(0, 8)}... : ${event.newStatus}`;

      await this.notificationsService.sendPushNotification(
        restaurant.ownerId,
        title,
        body,
        {
          orderId: event.orderId,
          type: 'status_update_restaurant',
          status: event.newStatus,
        },
      );
    }
  }

  private async notifyCustomerOrderCancelled(event: OrderCancelledEvent) {
    const title = '❌ Commande annulée';
    const body = event.cancelReason 
      ? `Votre commande a été annulée: ${event.cancelReason}` 
      : 'Votre commande a été annulée';

    await this.notificationsService.sendPushNotification(
      event.userId,
      title,
      body,
      {
        orderId: event.orderId,
        type: 'order_cancelled',
        refundAmount: event.refundAmount?.toString(),
      },
    );
  }

  private async notifyRestaurantOrderCancelled(event: OrderCancelledEvent) {
    const restaurant = await this.prisma.restaurant.findUnique({
      where: { id: event.restaurantId },
      select: { ownerId: true },
    });

    if (restaurant && event.cancelledBy !== restaurant.ownerId) {
      const title = '📋 Commande annulée';
      const body = `La commande ${event.orderId.substring(0, 8)}... a été annulée par le client`;

      await this.notificationsService.sendPushNotification(
        restaurant.ownerId,
        title,
        body,
        {
          orderId: event.orderId,
          type: 'order_cancelled_restaurant',
        },
      );
    }
  }

  // ===== MÉTHODES SSE =====

  // ===== MÉTHODES UTILITAIRES =====

  private async getFullOrderData(orderId: string) {
    return this.prisma.order.findUnique({
      where: { id: orderId },
      include: {
        restaurant: true,
        items: true,
        
      },
    });
  }

  private shouldNotifyRestaurantOfStatusUpdate(status: OrderStatus): boolean {
    // Notifier le restaurateur seulement pour certains statuts
    const statusesToNotify: OrderStatus[] = ['ANNULER', 'LIVRER'];
    return statusesToNotify.includes(status);
  }

  private getStatusUpdateMessage(status: OrderStatus, restaurantName: string): { title: string; body: string } {
    const messages = {
      EN_PREPARATION: {
        title: '👨‍🍳 En préparation',
        body: `Votre commande chez ${restaurantName} est en cours de préparation`,
      },
      PRET: {
        title: '✅ Commande prête',
        body: `Votre commande chez ${restaurantName} est prête !`,
      },
      EN_LIVRAISON: {
        title: '🚚 En livraison',
        body: `Votre commande chez ${restaurantName} est en cours de livraison`,
      },
      LIVRER: {
        title: '🎉 Commande livrée',
        body: `Votre commande chez ${restaurantName} a été livrée. Bon appétit !`,
      },
      ANNULER: {
        title: '❌ Commande annulée',
        body: `Votre commande chez ${restaurantName} a été annulée`,
      },
    };

    return messages[status] || {
      title: 'Mise à jour de commande',
      body: `Statut de votre commande: ${status}`,
    };
  }
}