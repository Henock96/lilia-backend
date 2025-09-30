/* eslint-disable prettier/prettier */

import { OrderStatus } from "@prisma/client";

// Event de base pour toutes les commandes
export abstract class BaseOrderEvent {
  constructor(
    public readonly orderId: string,
    public readonly userId: string,
    public readonly restaurantId: string,
    public readonly timestamp: Date = new Date(),
  ) {}
}

// Event pour la création d'une commande
export class OrderCreatedEvent extends BaseOrderEvent {
  constructor(
    orderId: string,
    userId: string,
    restaurantId: string,
    public readonly orderData: {
      totalAmount: number;
      itemCount: number;
      restaurantName: string;
      estimatedDeliveryTime?: Date;
    },
    timestamp?: Date,
  ) {
    super(orderId, userId, restaurantId, timestamp);
  }
}

// Event pour la mise à jour du statut d'une commande
export class OrderStatusUpdatedEvent extends BaseOrderEvent {
  constructor(
    orderId: string,
    userId: string,
    restaurantId: string,
    public readonly previousStatus: OrderStatus,
    public readonly newStatus: OrderStatus,
    public readonly updatedBy: string, // ID de l'utilisateur qui a fait la mise à jour
    public readonly orderData: {
      restaurantName: string;
      totalAmount?: number;
      estimatedDeliveryTime?: Date;
    },
    timestamp?: Date,
  ) {
    super(orderId, userId, restaurantId, timestamp);
}
}

// Event pour l'annulation d'une commande
export class OrderCancelledEvent extends BaseOrderEvent {
  constructor(
    orderId: string,
    userId: string,
    restaurantId: string,
    public readonly cancelledBy: string,
    public readonly cancelReason?: string,
    public readonly refundAmount?: number,
    timestamp?: Date,
  ) {
    super(orderId, userId, restaurantId, timestamp);
  }
}

export class OrderPaymentConfirmedEvent extends BaseOrderEvent {
  constructor(
    orderId: string,
    userId: string,
    restaurantId: string,
    public readonly paymentId: string,
    public readonly amount: number,
    public readonly currency: string = 'XAF',
    public readonly paymentMethod: string = 'MTN_MOMO',
    timestamp?: Date,
  ) {
    super(orderId, userId, restaurantId, timestamp);
  }
}