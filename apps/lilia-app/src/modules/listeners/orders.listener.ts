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

  private getStatusMessage(status: OrderStatus): { title: string; body: string } {
    const map: Record<OrderStatus, { title: string; body: string }> = {
      EN_ATTENTE:     { title: '⏳ Commande en attente', body: 'Votre commande est en attente de paiement' },
      PAYER:          { title: '💸 Paiement confirmé', body: 'Votre paiement a été accepté' },
      EN_PREPARATION: { title: '👨‍🍳 En préparation', body: 'Le restaurant prépare votre commande' },
      PRET:           { title: '✅ Commande prête', body: 'Votre commande est prête !' },
      EN_ROUTE:       { title: '🛵 En route', body: 'Votre livreur est en chemin !' },
      LIVRER:         { title: '🎉 Commande livrée', body: 'Votre commande a été livrée. Bon appétit !' },
      ANNULER:        { title: '❌ Commande annulée', body: 'Votre commande a été annulée' },
    };
    return map[status] ?? { title: 'Mise à jour', body: `Statut : ${status}` };
  }
}