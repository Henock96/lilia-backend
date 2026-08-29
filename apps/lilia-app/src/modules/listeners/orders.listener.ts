/* eslint-disable prettier/prettier */
import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../../prisma/prisma.service';
import { OrderCreatedEvent, OrderStatusUpdatedEvent, OrderCancelledEvent } from '../events/order-events';
import { OrderStatus } from '@prisma/client';
import { TrackingGateway } from '../tracking/tracking.gateway';
import { OutboxService } from '../outbox/outbox.service';

@Injectable()
export class OrdersListener {
  private readonly logger = new Logger(OrdersListener.name);

  constructor(
    private readonly notificationsService: NotificationsService,
    private readonly prisma: PrismaService,
    private readonly trackingGateway: TrackingGateway, // injecté pour notifier les clients en temps réel
    private readonly outbox: OutboxService,
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

    const [, vendorNotification] = await Promise.allSettled([
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

    // Fix H7 : on n'acquitte l'outbox QUE si la notification vendeur est
    // réellement partie. Sinon la ligne reste PENDING et le dispatcher la
    // reprend avec retry puis escalade SMS — c'est le signal le plus critique
    // du métier, il ne doit pas dépendre d'un push best-effort.
    if (event.outboxId && vendorNotification.status === 'fulfilled') {
      await this.outbox.markSent(event.outboxId);
    }
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

    // Notification au restaurant : uniquement LIVRER et ANNULER.
    //
    // `EN_ROUTE` a été RETIRÉ de cette liste : depuis que la commande n'y passe
    // qu'à la récupération réelle du repas, c'est `DeliveriesListener
    // .handlePickedUp` qui prévient le restaurant, avec un message qui dit
    // quelque chose (« X a récupéré la commande #ABC ») plutôt qu'un enum brut.
    // Les garder tous les deux enverrait deux push pour un seul geste.
    const notifyRestaurantOn: OrderStatus[] = ['LIVRER', 'ANNULER'];
    if (notifyRestaurantOn.includes(event.newStatus)) {
      const restaurant = await this.prisma.restaurant.findUnique({
        where: { id: event.restaurantId },
        select: { ownerId: true },
      });
      if (restaurant) {
        const shortId = event.orderId.slice(-6).toUpperCase();
        const restaurantMsg =
          event.newStatus === 'LIVRER'
            ? {
                title: '🎉 Commande livrée',
                body: `La commande #${shortId} a été livrée au client.`,
              }
            : {
                title: '❌ Commande annulée',
                body: `La commande #${shortId} a été annulée.`,
              };

        notifs.push(
          this.notificationsService.sendPushNotification(
            restaurant.ownerId,
            restaurantMsg.title,
            restaurantMsg.body,
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