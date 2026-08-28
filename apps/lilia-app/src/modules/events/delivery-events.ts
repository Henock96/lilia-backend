import { DeliveryStatus } from '@prisma/client';

/**
 * Events du cycle de vie d'une livraison.
 *
 * Les commandes passaient par des events (`order.*` → `OrdersListener`), les
 * livraisons non : la seule notification au livreur était appelée en dur dans
 * `DeliveryAssignmentService`. Conséquence, le livreur ne recevait **rien**
 * après l'assignation — ni quand sa commande devenait prête, ni quand elle
 * était annulée, ni quand sa mission lui était retirée.
 *
 * Ces events rétablissent la symétrie : les services décrivent ce qui s'est
 * passé, `DeliveriesListener` décide qui prévenir.
 */
export abstract class BaseDeliveryEvent {
  constructor(
    public readonly deliveryId: string,
    public readonly orderId: string,
    public readonly restaurantId: string,
    public readonly timestamp: Date = new Date(),
  ) {}
}

/** Un livreur vient de se voir confier une mission. */
export class DeliveryAssignedEvent extends BaseDeliveryEvent {
  constructor(
    deliveryId: string,
    orderId: string,
    restaurantId: string,
    public readonly delivererId: string,
    public readonly restaurantName: string,
    public readonly orderStatus: string,
    public readonly isPreorder: boolean,
    public readonly scheduledFor: Date | null,
    /**
     * Livreur qui tenait la mission avant, s'il y en avait un. Il faut le
     * prévenir et le libérer : sans ça il restait `ON_DELIVERY` à vie et ne
     * pouvait plus accepter aucune course.
     */
    public readonly previousDelivererId: string | null,
    timestamp?: Date,
  ) {
    super(deliveryId, orderId, restaurantId, timestamp);
  }
}

/** La commande est prête : le livreur assigné peut venir la chercher. */
export class DeliveryReadyForPickupEvent extends BaseDeliveryEvent {
  constructor(
    deliveryId: string,
    orderId: string,
    restaurantId: string,
    public readonly delivererId: string,
    public readonly restaurantName: string,
    timestamp?: Date,
  ) {
    super(deliveryId, orderId, restaurantId, timestamp);
  }
}

/**
 * La livraison a échoué.
 *
 * Ne décide **pas** du sort de la commande : c'est le vendeur qui tranche entre
 * réassigner un livreur et annuler. L'event sert à le prévenir (action requise),
 * à informer le client, et à tracer un incident pour qu'une commande oubliée
 * reste visible.
 */
export class DeliveryFailedEvent extends BaseDeliveryEvent {
  constructor(
    deliveryId: string,
    orderId: string,
    restaurantId: string,
    public readonly userId: string,
    public readonly delivererId: string | null,
    public readonly restaurantName: string,
    public readonly reason: string | null,
    public readonly failedBy: string,
    timestamp?: Date,
  ) {
    super(deliveryId, orderId, restaurantId, timestamp);
  }
}

/** La mission d'un livreur lui est retirée (réassignation ou annulation). */
export class DeliveryUnassignedEvent extends BaseDeliveryEvent {
  constructor(
    deliveryId: string,
    orderId: string,
    restaurantId: string,
    public readonly delivererId: string,
    public readonly cause: 'reassigned' | 'order_cancelled',
    timestamp?: Date,
  ) {
    super(deliveryId, orderId, restaurantId, timestamp);
  }
}

/** Transition de statut d'une livraison — trace générique. */
export class DeliveryStatusChangedEvent extends BaseDeliveryEvent {
  constructor(
    deliveryId: string,
    orderId: string,
    restaurantId: string,
    public readonly previousStatus: DeliveryStatus,
    public readonly newStatus: DeliveryStatus,
    public readonly changedBy: string,
    timestamp?: Date,
  ) {
    super(deliveryId, orderId, restaurantId, timestamp);
  }
}
