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
  //
  // ⚠️ Le VENDEUR n'est plus prévenu ici (chantier pawaPay, août 2026).
  //
  // Il l'était à `order.created`, donc **avant tout paiement**. Avec
  // l'encaissement manuel, l'écart entre la commande et le virement se comptait
  // en heures et le vendeur triait lui-même. Avec un prestataire qui tranche en
  // une minute, chaque paiement abandonné lui aurait valu un push pour une
  // commande qui n'existera jamais — et le vendeur aurait appris à les ignorer,
  // y compris les vraies.
  //
  // La notification vendeur part désormais de `order.paid`, dont l'obligation
  // est écrite dans la transaction de confirmation du paiement (§ PaymentService).
  @OnEvent('order.created')
  async handleOrderCreated(event: OrderCreatedEvent) {
    this.logger.log(`Commande créée : ${event.orderId}`);

    try {
      await this.notificationsService.sendPushNotification(
        event.userId,
        '🧾 Commande enregistrée',
        `Votre commande chez ${event.orderData.restaurantName} est enregistrée. Finalisez le paiement pour qu'elle soit préparée.`,
        { orderId: event.orderId, type: 'order_created' },
      );

      // Broadcast WebSocket — le client voit le statut EN_ATTENTE en temps réel
      this.trackingGateway.broadcastOrderStatus(event.orderId, 'EN_ATTENTE');
    } catch (error) {
      this.logger.error(
        `Erreur à la création de commande ${event.orderId} : ${error.message}`,
        error.stack,
      );
    }
  }

  // ===== COMMANDE PAYÉE — c'est ICI que le vendeur est prévenu =====
  //
  // L'obligation de notifier est écrite dans la MÊME transaction que le passage
  // à `PAYER` (`OutboxEvent` de type `order.paid`) : si la commande est payée,
  // la notification est due. Ce chemin-ci est le chemin rapide ; s'il échoue ou
  // si le processus meurt, `OutboxDispatcherService` reprend, avec backoff puis
  // escalade SMS.
  @OnEvent('order.paid')
  async handleOrderPaid(event: {
    orderId: string;
    userId: string;
    restaurantId: string;
    paymentId: string;
    amount: number;
    outboxId?: string;
  }) {
    this.logger.log(`Commande payée : ${event.orderId}`);

    try {
      const order = await this.prisma.order.findUnique({
        where: { id: event.orderId },
        select: {
          total: true,
          isDelivery: true,
          scheduledFor: true,
          _count: { select: { items: true } },
          restaurant: { select: { ownerId: true, nom: true } },
        },
      });

      if (!order) {
        this.logger.error(`Commande ${event.orderId} introuvable`);
        return;
      }

      const sent = await this.notificationsService
        .sendPushNotification(
          order.restaurant.ownerId,
          '🔔 Nouvelle commande payée',
          `${Math.round(order.total)} FCFA — ${order._count.items} article(s). À accepter.`,
          {
            orderId: event.orderId,
            type: 'new_order',
            customerId: event.userId,
          },
        )
        .then(() => true)
        .catch((err) => {
          this.logger.error(`Push vendeur échoué : ${err.message}`);
          return false;
        });

      // Fix H7 : on n'acquitte l'outbox QUE si la notification est réellement
      // partie. Sinon la ligne reste PENDING et le dispatcher la reprend — c'est
      // le signal le plus critique du métier, il ne doit pas dépendre d'un push
      // best-effort.
      if (event.outboxId && sent) {
        await this.outbox.markSent(event.outboxId);
      }

      this.trackingGateway.broadcastOrderStatus(event.orderId, 'PAYER');
    } catch (error) {
      this.logger.error(
        `Erreur au traitement de order.paid ${event.orderId} : ${error.message}`,
        error.stack,
      );
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