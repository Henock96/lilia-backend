import { Injectable } from '@nestjs/common';
import { OrderStatus } from '@prisma/client';
import { CreateOrderDto } from './dto/create-order.dto';
import { OrderQueryService } from './order-query.service';
import { OrderCheckoutService } from './order-checkout.service';
import {
  OrderLifecycleService,
  VendorRejection,
} from './order-lifecycle.service';
import { OrderReorderService } from './order-reorder.service';

/**
 * Façade du domaine commandes. Délègue aux services dédiés (LIL-134) :
 * - lectures → {@link OrderQueryService}
 * - checkout → {@link OrderCheckoutService}
 * - cycle de vie (annulation, statut, suppression, reorder) → {@link OrderLifecycleService}
 *
 * Conserve l'API publique consommée par OrdersController inchangée.
 */
@Injectable()
export class OrdersService {
  constructor(
    private readonly queryService: OrderQueryService,
    private readonly checkoutService: OrderCheckoutService,
    private readonly lifecycleService: OrderLifecycleService,
    private readonly reorderService: OrderReorderService,
  ) {}

  async createOrderFromCart(
    firebaseUid: string,
    dto: CreateOrderDto,
    idempotencyKey?: string,
  ) {
    return this.checkoutService.createOrderFromCart(
      firebaseUid,
      dto,
      idempotencyKey,
    );
  }

  /**
   * Récupère une commande par son ID — accessible par son propriétaire ou un admin.
   */
  async findOrderById(orderId: string, firebaseUid: string) {
    return this.queryService.findOrderById(orderId, firebaseUid);
  }

  /**
   * Récupère les commandes d'un client spécifique.
   */
  async findOrdersClient(page = 1, limit = 10, firebaseUid: string) {
    return this.queryService.findOrdersClient(page, limit, firebaseUid);
  }

  /**
   * Commandes bloquées — alimente l'alerte du tableau de bord.
   * Périmètre résolu par le rôle, comme `findRestaurantOrders`.
   */
  async countStuckOrders(firebaseUid: string, minutes?: number) {
    return this.queryService.countStuckOrders(firebaseUid, minutes);
  }

  /**
   * Récupère les commandes d'un restaurant spécifique.
   * ADMIN voit toutes les commandes de tous les restaurants.
   */
  async findRestaurantOrders(
    firebaseUid: string,
    page = 1,
    limit = 20,
    status?: string,
    search?: string,
  ) {
    return this.queryService.findRestaurantOrders(
      firebaseUid,
      page,
      limit,
      status,
      search,
    );
  }

  /**
   * Annule une commande pour un client.
   */
  async cancelOrder(orderId: string, firebaseUid: string) {
    return this.lifecycleService.cancelOrder(orderId, firebaseUid);
  }

  /**
   * Met à jour le statut d'une commande par un restaurateur.
   */
  async updateOrderStatusByRestaurateur(
    orderId: string,
    firebaseUid: string,
    newStatus: OrderStatus,
  ) {
    return this.lifecycleService.updateOrderStatusByRestaurateur(
      orderId,
      firebaseUid,
      newStatus,
    );
  }

  /** Le vendeur accepte une commande payée (F3-01). */
  /** Client, retrait : « J'ai récupéré ma commande » (F3-07). Rend la commande à jour. */
  async confirmPickup(orderId: string, firebaseUid: string) {
    await this.lifecycleService.confirmPickupByCustomer(orderId, firebaseUid);
    return this.queryService.findOrderById(orderId, firebaseUid);
  }

  /** Vendeur, retrait : remise avec le code du client (F3-07, D-P5). */
  handOverPickupWithCode(orderId: string, firebaseUid: string, code: string) {
    return this.lifecycleService.handOverPickupWithCode(
      orderId,
      firebaseUid,
      code,
    );
  }

  acceptOrder(orderId: string, firebaseUid: string, prepMinutes: number) {
    return this.lifecycleService.acceptOrder(orderId, firebaseUid, prepMinutes);
  }

  /** Le vendeur refuse une commande payée ou acceptée (F3-01). */
  rejectOrder(
    orderId: string,
    firebaseUid: string,
    rejection: VendorRejection,
  ) {
    return this.lifecycleService.rejectOrder(orderId, firebaseUid, rejection);
  }

  /**
   * Supprime (soft delete) une commande annulée pour un client.
   */
  async deleteOrder(orderId: string, firebaseUid: string) {
    return this.lifecycleService.deleteOrder(orderId, firebaseUid);
  }
  /**
   * Invalide les commandes EN_ATTENTE contenant des produits en rupture de stock.
   * Passe ces commandes en ANNULER et notifie le client.
   */
  /**
   * Recommande (reorder) une commande précédente.
   * Ajoute tous les produits de la commande au panier actuel.
   */
  async reorderFromPreviousOrder(orderId: string, firebaseUid: string) {
    return this.reorderService.reorderFromPreviousOrder(orderId, firebaseUid);
  }

  // orders/orders.service.ts — à ajouter
  countUnhandledRestaurantOrders(firebaseUid: string) {
    return this.queryService.countUnhandledRestaurantOrders(firebaseUid);
  }

  async findOrdersByUserId(
    userId: string,
    caller?: { role: string },
    page?: number,
    limit?: number,
  ) {
    return this.queryService.findOrdersByUserId(userId, caller, page, limit);
  }
}
