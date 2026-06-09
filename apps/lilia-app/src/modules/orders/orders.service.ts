import {
  BadRequestException,
  Injectable,
  NotFoundException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { OrderStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  OrderCancelledEvent,
  OrderCreatedEvent,
  OrderStatusUpdatedEvent,
} from '../events/order-events';
import { PaginationService } from '../../common/pagination/pagination.service';
import { OrderQueryService } from './order-query.service';
import { OrderCheckoutService } from './order-checkout.service';
import { OrderStateMachine } from './order-state.machine';
import { StockService } from './stock.service';
import { OrderValidatorService } from './order-validator.service';
import { OrderCalculatorService } from './order-calculator.service';
import { PromoService, PromoValidationResult } from '../promo/promo.service';
import { ConfigService } from '@nestjs/config';
import { PlatformSettingsService } from '../platform-settings/platform-settings.service';
import { PreorderValidatorService } from '../vendors/preorder-validator.service';
import { QuartiersService } from '../quartiers/quartiers.service';
import Redis from 'ioredis';

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);
  constructor(
    private prisma: PrismaService,
    private eventEmitter: EventEmitter2,
    private readonly stateMachine: OrderStateMachine,
    private readonly stockService: StockService,
    private readonly platformSettings: PlatformSettingsService,
    private readonly queryService: OrderQueryService,
    private readonly checkoutService: OrderCheckoutService,
  ) {}

  private async awardLoyaltyPoints(userId: string, orderId: string, subTotal: number): Promise<void> {
    const settings = await this.platformSettings.getSettings();
    const points = Math.floor(subTotal / 100) * settings.loyaltyPointsPer100Xaf;
    if (points <= 0) return;

    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: userId },
        data: { loyaltyPoints: { increment: points } },
      }),
      this.prisma.loyaltyTransaction.create({
        data: { userId, orderId, points, reason: `+${points} pts — commande livrée` },
      }),
    ]);

    this.logger.log(`⭐ +${points} points fidélité user ${userId}`);
  }

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
    const user = await this.prisma.user.findUnique({ where: { firebaseUid } });
    if (!user) {
      throw new NotFoundException('Utilisateur non trouvé.');
    }

    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { restaurant: true, items: true },
    });

    if (!order) {
      throw new NotFoundException('Commande non trouvée.');
    }

    if (order.userId !== user.id) {
      throw new ForbiddenException(
        "Vous n'êtes pas autorisé à annuler cette commande.",
      );
    }

    // Passe par la state machine — CLIENT peut annuler depuis EN_ATTENTE ou PAYER
    this.stateMachine.assertTransition(order.status, 'ANNULER', 'CLIENT');

    // Annulation + restauration du stock réservé au checkout, en une transaction
    // (sinon le stock décrémenté à la commande est perdu = stock fantôme).
    const updatedOrder = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.order.update({
        where: { id: orderId },
        data: { status: 'ANNULER' },
        include: {
          restaurant: true,
          items: true, // Correction: Toujours inclure les items
        },
      });
      await this.stockService.restoreInTransaction(tx, order.items);
      return updated;
    });
    const orderCancelledEvent = new OrderCancelledEvent(
      order.id,
      order.userId,
      order.restaurantId,
      'Client', // cancelledBy
      null, // cancelReason
      order.total >= 1000 ? order.total : 0, // refundAmount: rembourser si >= 1000
    );

    this.eventEmitter.emit('order.cancelled', orderCancelledEvent);
    return updatedOrder;
  }

  /**
   * Met à jour le statut d'une commande par un restaurateur.
   */
  async updateOrderStatusByRestaurateur(
    orderId: string,
    firebaseUid: string,
    newStatus: OrderStatus,
  ) {
    this.logger.log(
      `🔄 [STATUT] Début mise à jour - commande: ${orderId}, nouveau statut: ${newStatus}, par: ${firebaseUid}`,
    );

    const user = await this.prisma.user.findUnique({ where: { firebaseUid } });
    if (!user || (user.role !== 'RESTAURATEUR' && user.role !== 'ADMIN')) {
      this.logger.warn(
        `🔄 [STATUT] Échec: accès refusé - user: ${firebaseUid}, rôle: ${user?.role || 'inconnu'}`,
      );
      throw new ForbiddenException(
        "Vous n'êtes pas autorisé à effectuer cette action.",
      );
    }
    this.logger.log(`🔄 [STATUT] Autorisé: ${user.id} (${user.role})`);
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { restaurant: true },
    });

    if (!order) {
      this.logger.warn(`🔄 [STATUT] Échec: commande ${orderId} introuvable`);
      throw new NotFoundException('Commande non trouvée.');
    }
    this.logger.log(
      `🔄 [STATUT] Commande trouvée: ${orderId}, statut actuel: ${order.status}, client: ${order.userId}, restaurant: ${order.restaurant.nom}`,
    );
    if (user.role !== 'ADMIN' && order.restaurant.ownerId !== user.id) {
      throw new ForbiddenException(
        "Cette commande n'appartient pas à votre restaurant.",
      );
    }

    const actor = this.resolveActor(user.role);
    if (!actor) throw new ForbiddenException('Acteur invalide pour cette transition');
    this.stateMachine.assertTransition(order.status, newStatus, actor);

    const updatedOrder = await this.prisma.order.update({
      where: { id: orderId },
      data: { status: newStatus },
      include: {
        restaurant: true,
        items: true, // Correction: Toujours inclure les items
      },
    });

    // 🔥 ÉMETTRE L'ÉVÉNEMENT au lieu d'appeler directement les notifications
    const statusUpdatedEvent = new OrderStatusUpdatedEvent(
      updatedOrder.id,
      updatedOrder.userId,
      updatedOrder.restaurantId,
      order.status, // L'ancien statut (avant la mise à jour)
      newStatus, // Le nouveau statut
      user.id, // updatedBy
      {
        restaurantName: updatedOrder.restaurant.nom,
        totalAmount: updatedOrder.total,
      },
    );

    this.eventEmitter.emit('order.status.updated', statusUpdatedEvent);
    this.logger.log(
      `🔄 [STATUT] Succès: commande ${orderId} - ${order.status} → ${newStatus} (par ${user.id}/${user.role})`,
    );

    // Points fidélité quand la commande est livrée (non-bloquant)
    if (newStatus === 'LIVRER') {
      this.awardLoyaltyPoints(updatedOrder.userId, orderId, updatedOrder.subTotal).catch((err) =>
        this.logger.error(`Erreur points fidélité: ${err}`),
      );
    }

    return updatedOrder;
  }

  /**
   * Supprime (soft delete) une commande annulée pour un client.
   */
  async deleteOrder(orderId: string, firebaseUid: string) {
    const user = await this.prisma.user.findUnique({ where: { firebaseUid } });
    if (!user) {
      throw new NotFoundException('Utilisateur non trouvé.');
    }

    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
    });

    if (!order) {
      throw new NotFoundException('Commande non trouvée.');
    }

    if (order.userId !== user.id) {
      throw new ForbiddenException(
        "Vous n'êtes pas autorisé à supprimer cette commande.",
      );
    }

    if (order.status !== 'ANNULER') {
      throw new BadRequestException(
        'Seules les commandes annulées peuvent être supprimées.',
      );
    }

    await this.prisma.order.update({
      where: { id: orderId },
      data: { deleteCommande: true },
    });

    return { message: 'Commande supprimée avec succès.' };
  }
  private resolveActor(
    role: string,
  ): 'CLIENT' | 'RESTAURATEUR' | 'ADMIN' | 'LIVREUR' | null {
    const map: Record<string, any> = {
      CLIENT: 'CLIENT',
      RESTAURATEUR: 'RESTAURATEUR',
      ADMIN: 'ADMIN',
      LIVREUR: 'LIVREUR',
    };
    return map[role] ?? null;
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
    // 1. Vérifier l'utilisateur
    const user = await this.prisma.user.findUnique({
      where: { firebaseUid },
      include: { cart: true },
    });

    if (!user) {
      throw new NotFoundException('Utilisateur non trouvé.');
    }

    // 2. Récupérer la commande avec ses items
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: {
        items: {
          include: {
            product: {
              include: {
                variants: true,
              },
            },
          },
        },
        restaurant: {
          select: {
            id: true,
            nom: true,
          },
        },
      },
    });

    if (!order) {
      throw new NotFoundException('Commande non trouvée.');
    }

    // 3. Vérifier que l'utilisateur est le propriétaire de la commande
    if (order.userId !== user.id) {
      throw new ForbiddenException('Cette commande ne vous appartient pas.');
    }

    // 4. Vérifier le panier actuel
    let cart = user.cart;
    if (!cart) {
      cart = await this.prisma.cart.create({
        data: { userId: user.id },
      });
    }

    // Récupérer les items actuels du panier
    const currentCartItems = await this.prisma.cartItem.findMany({
      where: { cartId: cart.id },
      include: { product: true },
    });

    // Vérifier si le panier contient des items d'un autre restaurant
    if (currentCartItems.length > 0) {
      const currentRestaurantId = currentCartItems[0].product.restaurantId;

      if (currentRestaurantId !== order.restaurantId) {
        throw new BadRequestException(
          `Votre panier contient déjà des articles d'un autre restaurant. Veuillez le vider pour commander de ${order.restaurant.nom}.`,
        );
      }
    }

    // 5. Ajouter les items de la commande au panier
    const results = {
      added: [],
      unavailable: [],
      errors: [],
    };

    this.logger.log(
      `🔄 [REORDER] Commande ${orderId}: ${order.items.length} items à ajouter au panier`,
    );

    for (const orderItem of order.items) {
      try {
        // Vérifier que le produit existe toujours
        const product = orderItem.product;
        this.logger.log(
          `🔄 [REORDER] Item: productId=${orderItem.productId}, variant="${orderItem.variant}", product exists=${!!product}, variants count=${product?.variants?.length ?? 0}`,
        );
        if (!product) {
          results.unavailable.push({
            productId: orderItem.productId,
            reason: 'Produit introuvable',
          });
          continue;
        }

        // Trouver la variante correspondante
        // 1. Chercher par label exact
        let variant = product.variants.find(
          (v) => v.label === orderItem.variant,
        );

        // 2. Chercher par label case-insensitive / trimmed
        if (!variant) {
          const orderVariantLower = (orderItem.variant || '')
            .trim()
            .toLowerCase();
          variant = product.variants.find(
            (v) => (v.label || '').trim().toLowerCase() === orderVariantLower,
          );
        }

        // 3. Si la variante n'existe plus, prendre la première disponible
        if (!variant && product.variants.length > 0) {
          variant = product.variants[0];
          this.logger.warn(
            `Variant "${orderItem.variant}" not found for product ${product.id}, using default variant "${variant.label}"`,
          );
        }

        if (!variant) {
          results.unavailable.push({
            productName: product.nom,
            reason: 'Aucune variante disponible',
          });
          continue;
        }

        // Vérifier si l'item existe déjà dans le panier (individuel uniquement)
        const existingCartItem = await this.prisma.cartItem.findFirst({
          where: {
            cartId: cart.id,
            variantId: variant.id,
            menuId: null,
          },
        });

        if (existingCartItem) {
          // Mettre à jour la quantité
          await this.prisma.cartItem.update({
            where: { id: existingCartItem.id },
            data: {
              quantite: existingCartItem.quantite + orderItem.quantite,
            },
          });
        } else {
          // Créer un nouvel item
          await this.prisma.cartItem.create({
            data: {
              cartId: cart.id,
              productId: product.id,
              variantId: variant.id,
              quantite: orderItem.quantite,
            },
          });
        }

        results.added.push({
          productName: product.nom,
          variant: variant.label,
          quantity: orderItem.quantite,
        });
      } catch (error) {
        this.logger.error(
          `Error adding item ${orderItem.productId} to cart:`,
          error,
        );
        results.errors.push({
          productId: orderItem.productId,
          //error: error.message,
        });
      }
    }

    // 6. Récupérer le panier mis à jour
    const updatedCart = await this.prisma.cart.findUnique({
      where: { id: cart.id },
      include: {
        items: {
          include: {
            product: {
              select: {
                nom: true,
                imageUrl: true,
                restaurantId: true,
              },
            },
            variant: {
              select: {
                label: true,
                prix: true,
              },
            },
          },
        },
      },
    });

    return {
      message: 'Commande ajoutée au panier avec succès',
      cart: updatedCart,
      summary: {
        totalAdded: results.added.length,
        totalUnavailable: results.unavailable.length,
        totalErrors: results.errors.length,
      },
      details: results,
    };
  }

  // orders/orders.service.ts — à ajouter
  async findOrdersByUserId(userId: string, caller?: { role: string }) {
    return this.queryService.findOrdersByUserId(userId, caller);
  }
}
