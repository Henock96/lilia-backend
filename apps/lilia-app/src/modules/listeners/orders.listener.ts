/* eslint-disable prettier/prettier */
import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../../prisma/prisma.service';
import { OrderCreatedEvent, OrderStatusUpdatedEvent, OrderCancelledEvent } from '../events/order-events';
import { OrderStatus } from '@prisma/client';
import { TrackingGateway } from '../tracking/tracking.gateway';

@Injectable()
export class OrdersListener {
  private readonly logger = new Logger(OrdersListener.name);

  constructor(
    private readonly notificationsService: NotificationsService,
    private readonly prisma: PrismaService,
    private readonly trackingGateway: TrackingGateway, // injecté pour notifier les clients en temps réel
  ) {}


  // ===== CRÉATION DE COMMANDE =====
  @OnEvent('order.created')
  async handleOrderCreated(event: OrderCreatedEvent) {
    this.logger.log(`Handling order created event: ${event.orderId}`);

    try {
       // 1 seule requête pour récupérer l'ownerId du restaurant
    const restaurant = await this.prisma.restaurant.findUnique({
      where: { id: event.restaurantId },
      select: { ownerId: true, nom: true },
    });

    await Promise.allSettled([
      // Notif client
      this.notificationsService.sendPushNotification(
        event.userId,
        '🎉 Commande reçue',
        `Votre commande chez ${event.orderData.restaurantName} est confirmée. Total : ${event.orderData.totalAmount} FCFA`,
        { orderId: event.orderId, type: 'order_created' },
      ),
      // Notif restaurant
      restaurant
        ? this.notificationsService.sendPushNotification(
            restaurant.ownerId,
            '🔔 Nouvelle commande',
            `${event.orderData.totalAmount} FCFA — ${event.orderData.itemCount} article(s)`,
            { orderId: event.orderId, type: 'new_order', customerId: event.userId },
          )
        : Promise.resolve(),
    ]);
      // Broadcast WebSocket — le client voit le statut EN_ATTENTE en temps réel
    this.trackingGateway.broadcastOrderStatus(event.orderId, 'EN_ATTENTE');
      this.logger.log(`Notifications de création de commande envoyées pour: ${event.orderId}`);
    } catch (error) {
      this.logger.error(`Erreur lors de la gestion de l'événement de création de commande: ${error.message}`, error.stack);
    }
  }

  // ===== MISE À JOUR DE STATUT =====
  @OnEvent('order.status.updated')
  async handleOrderStatusUpdated(event: OrderStatusUpdatedEvent) {
    this.logger.log(`order.status.updated : ${event.orderId} → ${event.newStatus}`);
    // Le client voit le changement de statut en temps réel sur sa carte
    this.trackingGateway.broadcastOrderStatus(event.orderId, event.newStatus);
    const msg = this.getStatusMessage(event.newStatus);
    const notifs: Promise<any>[] = [
      this.notificationsService.sendPushNotification(
        event.userId,
        msg.title,
        msg.body,
        { orderId: event.orderId, type: 'status_update', status: event.newStatus },
      ),
    ];

    // Notifie le restaurant uniquement pour LIVRER et ANNULER
    const notifyRestaurantOn: OrderStatus[] = ['EN_ROUTE','LIVRER', 'ANNULER'];
    if (notifyRestaurantOn.includes(event.newStatus)) {
      const restaurant = await this.prisma.restaurant.findUnique({
        where: { id: event.restaurantId },
        select: { ownerId: true },
      });
      if (restaurant) {
        notifs.push(
          this.notificationsService.sendPushNotification(
            restaurant.ownerId,
            'Statut commande',
            `Commande #${event.orderId.slice(-6)} : ${event.newStatus}`,
            { orderId: event.orderId, type: 'status_update_restaurant' },
          ),
        );
      }
    }

    await Promise.allSettled(notifs);
  }

  // ===== ANNULATION DE COMMANDE =====
  @OnEvent('order.cancelled')
  async handleOrderCancelled(event: OrderCancelledEvent) {
    this.logger.log(`order.cancelled : ${event.orderId}`);
     // Broadcast WebSocket — ferme le tracking côté client
    this.trackingGateway.broadcastOrderStatus(event.orderId, 'ANNULER');
    const restaurant = await this.prisma.restaurant.findUnique({
      where: { id: event.restaurantId },
      select: { ownerId: true },
    });

    const body = event.cancelReason
      ? `Commande annulée : ${event.cancelReason}`
      : 'Votre commande a été annulée';

    await Promise.allSettled([
      this.notificationsService.sendPushNotification(
        event.userId,
        'Commande annulée',
        body,
        { orderId: event.orderId, type: 'order_cancelled' },
      ),
      restaurant && restaurant.ownerId !== event.cancelledBy
        ? this.notificationsService.sendPushNotification(
            restaurant.ownerId,
            'Commande annulée',
            `La commande #${event.orderId.slice(-6)} a été annulée`,
            { orderId: event.orderId, type: 'order_cancelled_restaurant' },
          )
        : Promise.resolve(),
    ]);
  }

  // ===== MÉTHODES PRIVÉES POUR NOTIFICATIONS =====
  private async notifyCustomerOrderCreated(event: OrderCreatedEvent) {
    const title = '🎉 Commande confirmée !';
    const body = `Votre commande chez Lilia Food a été reçue. Montant: ${event.orderData.totalAmount} FCFA`;

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
    const { title, body } = this.getStatusUpdateMessage(event.newStatus);

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
  // ===== MÉTHODES PRIVÉES POUR NOTIFICATIONS =====
  private getStatusMessage(status: OrderStatus): { title: string; body: string } {
    const map: Record<string, { title: string; body: string }> = {
      PAYER:          { title: '💸 Paiement confirmé', body: 'Votre paiement a été accepté' },
      EN_PREPARATION: { title: '👨‍🍳 En préparation', body: 'Le restaurant prépare votre commande' },
      PRET:           { title: '✅ Commande prête', body: 'Votre commande est prête !' },
      EN_LIVRAISON:   { title: 'En route 🛵', body: 'Votre livreur est en chemin !' },
      LIVRER:         { title: '🎉 Commande livrée', body: 'Votre commande a été livrée. Bon appétit !' },
      ANNULER:        { title: '❌ Commande annulée', body: 'Votre commande a été annulée' },
    };
    return map[status] ?? { title: 'Mise à jour', body: `Statut : ${status}` };
  }
  private getStatusUpdateMessage(status: OrderStatus): { title: string; body: string } {
    const messages = {
      EN_ATTENTE: {
        title: '♾️ En Attente',
        body: `Votre commande Lilia Food est en attente de préparation`,
      },
      PAYER: {
        title: ' Payez',
        body: `Votre commande Lilia Food a été payée avec succès`,
      },
      EN_PREPARATION: {
        title: '👨‍🍳 En préparation',
        body: `Votre commande Lilia Food est en cours de préparation`,
      },
      
      PRET: {
        title: '✅ Commande prête',
        body: `Votre commande Lilia Food est prête !`,
      },
      EN_ROUTE: {
        title: 'En route 🛵',
        body: `Votre livreur est en chemin pour livrer votre commande Lilia Food !`,
      },
      LIVRER: {
        title: '🎉 Commande livrée',
        body: `Votre commande Lilia Food a été livrée. Bon appétit !`,
      },
      ANNULER: {
        title: '❌ Commande annulée',
        body: `Votre commande Lilia Food a été annulée`,
      },
    };

    return messages[status] || {
      title: 'Mise à jour de commande',
      body: `Statut de votre commande: ${status}`,
    };
  }
}