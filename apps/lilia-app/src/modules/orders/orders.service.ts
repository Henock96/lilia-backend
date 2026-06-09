import { Injectable } from '@nestjs/common';
import { OrderStatus } from '@prisma/client';
import { CreateOrderDto } from './dto/create-order.dto';
import { OrderQueryService } from './order-query.service';
import { OrderCheckoutService } from './order-checkout.service';
import { OrderLifecycleService } from './order-lifecycle.service';

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
  ) {}

  async createOrderFromCart(firebaseUid: string, dto: CreateOrderDto, idempotencyKey?: string) {
    return this.checkoutService.createOrderFromCart(firebaseUid, dto, idempotencyKey);
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
   * Récupère les commandes d'un restaurant spécifique.
   * ADMIN voit toutes les commandes de tous les restaurants.
   */
  async findRestaurantOrders(firebaseUid: string, page = 1, limit = 20) {
    return this.queryService.findRestaurantOrders(firebaseUid, page, limit);
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
    return this.lifecycleService.updateOrderStatusByRestaurateur(orderId, firebaseUid, newStatus);
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
    return this.lifecycleService.reorderFromPreviousOrder(orderId, firebaseUid);
  }

  // orders/orders.service.ts — à ajouter
  async findOrdersByUserId(userId: string, caller?: { role: string }) {
    return this.queryService.findOrdersByUserId(userId, caller);
  }
}
