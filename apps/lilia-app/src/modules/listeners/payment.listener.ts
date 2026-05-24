/* eslint-disable prettier/prettier */
import { Injectable, Logger } from '@nestjs/common';
import { OnEvent, EventEmitter2 } from '@nestjs/event-emitter';
import { OrderStatus } from '@prisma/client';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../../prisma/prisma.service';
import { OrderPaymentConfirmedEvent, OrderStatusUpdatedEvent } from '../events/order-events';

@Injectable()
export class PaymentListener {
  private readonly logger = new Logger(PaymentListener.name);

  constructor(
    private readonly notificationsService: NotificationsService,
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  @OnEvent('order.payment.confirmed')
  async handlePaymentConfirmed(event: OrderPaymentConfirmedEvent) {
    this.logger.log(`🎉 Payment confirmed for order: ${event.orderId}`);
    this.logger.log(`💰 Amount: ${event.amount} ${event.currency}`);
    this.logger.log(`💳 Payment ID: ${event.paymentId}`);

    try {
      // 1. Récupérer les détails de la commande
      const order = await this.prisma.order.findUnique({
        where: { id: event.orderId },
        include: {       
          restaurant: true,
          items: {
            include: {
              product: true,
            },
            
          },
          
        },
      });

      if (!order) {
        this.logger.error(`Order ${event.orderId} not found`);
        return;
      }

      // 2. Notifier le client (Push Notification)
      await this.notifyCustomerPaymentSuccess(event, order);

      // 3. Notifier le restaurateur (Push Notification)
      await this.notifyRestaurantPaymentReceived(event, order);

      // 4. Envoyer les événements SSE
      //await this.sendPaymentConfirmedSSE(event, order);

      // 5. Mettre à jour le statut de la commande
      await this.updateOrderAfterPayment(event.orderId);

      this.logger.log(`✅ Payment notifications sent for order: ${event.orderId}`);
    } catch (error) {
      this.logger.error(`❌ Error handling payment confirmed event: ${error.message}`, error.stack);
    }
  }

  // ===== Notifications Push =====

  private async notifyCustomerPaymentSuccess(
    event: OrderPaymentConfirmedEvent,
    order: any,
  ) {
    const title = '✅ Paiement confirmé !';
    const body = `Votre paiement de ${event.amount} ${event.currency} a été confirmé. Votre commande chez ${order.restaurant.name} est en cours de préparation.`;

    await this.notificationsService.sendPushNotification(
      event.userId,
      title,
      body,
      {
        orderId: event.orderId,
        paymentId: event.paymentId,
        type: 'payment_confirmed',
        amount: event.amount.toString(),
        currency: event.currency,
        restaurantId: event.restaurantId,
        restaurantName: order.restaurant.name,
      },
    );

    this.logger.log(`📱 Push notification sent to customer: ${event.userId}`);
  }

  private async notifyRestaurantPaymentReceived(
    event,
    order: any,
  ) {
    const title = '💰 Paiement reçu';
  // ✅ Fix : 'nom' pas 'name'
  const body = `Paiement de ${event.amount} ${event.currency} reçu. ${order.items.length} article(s).`;

  await this.notificationsService.sendPushNotification(
    order.restaurant.ownerId,
    title,
    body,
    { orderId: event.orderId, type: 'payment_received', amount: event.amount.toString() },
  );
}

  // ===== Événements SSE =====

  // ===== Mise à jour de la commande =====

  private async updateOrderAfterPayment(orderId: string) {
    try {
      // PaymentService.handleSuccessfulPayment vient de mettre Order.status = PAYER.
      // On enchaîne PAYER → EN_PREPARATION en émettant `order.status.updated`
      // pour que le client reçoive la notif "👨‍🍳 En préparation" + broadcast WS.
      const order = await this.prisma.order.findUnique({
        where: { id: orderId },
        select: { userId: true, restaurantId: true, status: true, restaurant: { select: { nom: true } }, total: true },
      });

      if (!order) {
        this.logger.warn(`updateOrderAfterPayment: order ${orderId} not found`);
        return;
      }

      const previousStatus = order.status;

      await this.prisma.order.update({
        where: { id: orderId },
        data: {
          status: 'EN_PREPARATION',
          paidAt: new Date(),
        },
      });

      // Émet l'event → OrdersListener notifie le client + broadcast WS
      const statusEvent = new OrderStatusUpdatedEvent(
        orderId,
        order.userId,
        order.restaurantId,
        previousStatus,
        OrderStatus.EN_PREPARATION,
        order.userId, // pas d'acteur explicite (déclenché par PaymentListener) — on attache le user pour le contexte
        {
          restaurantName: order.restaurant.nom,
          totalAmount: order.total,
        },
      );
      this.eventEmitter.emit('order.status.updated', statusEvent);

      this.logger.log(`📝 Order ${orderId} status updated to EN_PREPARATION (event emitted)`);
    } catch (error) {
      this.logger.error(`Failed to update order status: ${error.message}`);
    }
  }

  // ===== Événement de paiement échoué =====

  @OnEvent('order.payment.failed')
  async handlePaymentFailed(event: {
    orderId: string;
    userId: string;
    paymentId: string;
    reason: string;
  }) {
    this.logger.log(`❌ Payment failed for order: ${event.orderId}`);
    this.logger.log(`Reason: ${event.reason}`);

    try {
      const order = await this.prisma.order.findUnique({
        where: { id: event.orderId },
        include: {
          restaurant: true,
        },
      });

      if (!order) return;

      // Notifier le client
      const title = '❌ Paiement échoué';
      const body = `Le paiement de votre commande chez ${order.restaurant.nom} a échoué. Raison: ${event.reason}`;

      await this.notificationsService.sendPushNotification(
        event.userId,
        title,
        body,
        {
          orderId: event.orderId,
          paymentId: event.paymentId,
          type: 'payment_failed',
          reason: event.reason,
        },
      );

      this.logger.log(`📱 Payment failure notification sent to customer: ${event.userId}`);
    } catch (error) {
      this.logger.error(`Error handling payment failed event: ${error.message}`);
    }
  }

  // ===== Événement de timeout de paiement =====

  @OnEvent('order.payment.timeout')
  async handlePaymentTimeout(event: {
    orderId: string;
    userId: string;
    paymentId: string;
  }) {
    this.logger.log(`⏰ Payment timeout for order: ${event.orderId}`);

    try {
      const order = await this.prisma.order.findUnique({
        where: { id: event.orderId },
        include: {
          restaurant: true,
        },
      });

      if (!order) return;

      // Notifier le client
      const title = '⏰ Délai de paiement expiré';
      const body = `Le délai de paiement pour votre commande chez ${order.restaurant.nom} a expiré. Veuillez réessayer.`;

      await this.notificationsService.sendPushNotification(
        event.userId,
        title,
        body,
        {
          orderId: event.orderId,
          paymentId: event.paymentId,
          type: 'payment_timeout',
        },
      );

      this.logger.log(`📱 Payment timeout notification sent to customer: ${event.userId}`);
    } catch (error) {
      this.logger.error(`Error handling payment timeout event: ${error.message}`);
    }
  }
}