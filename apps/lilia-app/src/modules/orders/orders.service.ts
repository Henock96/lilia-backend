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
import { OrderStateMachine } from './order-state.machine';
import { StockService } from './stock.service';
import { OrderValidatorService } from './order-validator.service';
import { OrderCalculatorService } from './order-calculator.service';
import { PromoService, PromoValidationResult } from '../promo/promo.service';

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);
  constructor(
    private prisma: PrismaService,
    private eventEmitter: EventEmitter2,
    private readonly pagination: PaginationService,
    private readonly stateMachine: OrderStateMachine,
    private readonly stockService: StockService,
    private readonly validator: OrderValidatorService,
    private readonly calculator: OrderCalculatorService,
    private readonly promoService: PromoService,
  ) {}

  /**
   * Crée une commande à partir du panier de l'utilisateur.
   * Utilise une transaction pour garantir l'intégrité des données.
   */
  async createOrderFromCart(firebaseUid: string, dto: CreateOrderDto) {
    const {
      adresseId,
      paymentMethod,
      notes,
      isDelivery = true,
      contactPhone,
      promoCode,
    } = dto;
    this.logger.log(
      `📦 [COMMANDE] Début création commande - user: ${firebaseUid}, payload: ${JSON.stringify({ adresseId: dto.adresseId, paymentMethod: dto.paymentMethod, isDelivery: dto.isDelivery })}`,
    );
    // 1. Validation — tout dans le validator, propre et testable
    const user = await this.validator.validateAndGetUser(firebaseUid);
    const cartItems = user.cart?.items ?? [];
    this.validator.validateCartNotEmpty(cartItems);
    const restaurantId = this.validator.validateSameRestaurant(cartItems);

    // 1. Vérifier l'adresse de livraison (seulement si c'est une livraison)
    let deliveryAddress: string | null = null;

    if (isDelivery) {
      if (!adresseId) {
        this.logger.warn(
          `📦 [COMMANDE] Échec: adresse manquante pour livraison - user: ${user.id}`,
        );
        throw new BadRequestException(
          'Une adresse de livraison est requise pour la livraison à domicile.',
        );
      }
      deliveryAddress = await this.validator.validateDeliveryAddress(
        adresseId,
        user.id,
      );
    } else {
      this.logger.log(`📦 [COMMANDE] Mode retrait au restaurant`);
    }
    const restaurant =
      await this.validator.validateRestaurantOpen(restaurantId);
    await this.validator.validateStock(cartItems);

    // 2. Calcul — isolé, testable unitairement
    const amounts = this.calculator.calculate(
      cartItems,
      restaurant.fixedDeliveryFee,
      isDelivery,
    );
    this.validator.validateMinimumOrderAmount(
      amounts.subTotal,
      restaurant.minimumOrderAmount,
      restaurant.nom,
    );
    const itemSnapshots = this.calculator.buildOrderItemSnapshots(cartItems);
    // Validation et calcul promo AVANT la transaction
    let promoResult: PromoValidationResult | null = null;
    if (promoCode) {
      promoResult = await this.promoService.validateCode(
        promoCode,
        user.id,
        restaurantId,
        amounts.subTotal,
        amounts.deliveryFee,
      );
    }

    // Montants finaux après promo
    const finalDeliveryFee = promoResult?.newDeliveryFee ?? amounts.deliveryFee;
    const discountAmount = promoResult?.discountAmount ?? 0;
    const finalTotal = amounts.subTotal + finalDeliveryFee + amounts.serviceFee - discountAmount;
    // 5. Exécuter la création de la commande et la suppression du panier dans une transaction
    const order = await this.prisma.$transaction(async (tx) => {
      const newOrder = await tx.order.create({
        data: {
          userId: user.id,
          restaurantId,
          subTotal: amounts.subTotal,
          deliveryFee: finalDeliveryFee,
          serviceFee: amounts.serviceFee,
          discountAmount,
          total: finalTotal,
          promoCodeId: promoResult?.promoCodeId ?? null,
          isDelivery,
          notes,
          contactPhone,
          deliveryAddress,
          paymentMethod,
          status: 'EN_ATTENTE',
          items: {
            create: itemSnapshots.map((snap) => ({
              productId: snap.productId,
              menuId: snap.menuId,
              quantite: snap.quantite,
              prix: snap.prix,
              variant: snap.variant,
              variantId: snap.variantId,
              snapshotPrice: snap.snapshotPrice,
            })),
          },
        },
        include: {
          items: true,
          restaurant: { select: { nom: true } }, // Correction: Toujours inclure le restaurant
        },
      });
      // Consomme le code dans la transaction
      if (promoResult) {
        await this.promoService.applyCode(
          tx,
          promoResult.promoCodeId,
          user.id,
          newOrder.id,
          discountAmount,
        );
      }

      // 6. Décrémenter le stock des produits et menus commandés
      await this.stockService.decrementInTransaction(tx, cartItems);

      // 7. Vider le panier
      await tx.cartItem.deleteMany({
        where: {
          cartId: user.cart!.id,
        },
      });

      return newOrder;
    });
    this.logger.log(
      `🔔 Nouvelles commandes:${order.id} au restaurant ${order.restaurantId} pour un total de ${order.total} FCFA.`,
    );
    // 🔥 ÉMETTRE L'ÉVÉNEMENT au lieu d'appeler directement les notifications
    const orderCreatedEvent = new OrderCreatedEvent(
      order.id,
      order.userId,
      order.restaurantId,
      {
        totalAmount: order.total,
        itemCount: order.items.length,
        restaurantName: order.restaurant.nom, // Exemple statique, à remplacer par une vraie estimation si disponible
      },
    );

    this.eventEmitter.emit('order.created', orderCreatedEvent);
    return {
      message: 'Commande créée avec succès.',
      data: order,
    };
  }

  /**
   * Récupère une commande par son ID — accessible par son propriétaire ou un admin.
   */
  async findOrderById(orderId: string, firebaseUid: string) {
    const user = await this.prisma.user.findUnique({ where: { firebaseUid } });
    if (!user) throw new NotFoundException('Utilisateur non trouvé.');

    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: {
        restaurant: { select: { nom: true, imageUrl: true, adresse: true } },
        items: {
          include: {
            product: { select: { nom: true, imageUrl: true } },
          },
        },
        delivery: true,
      },
    });

    if (!order) throw new NotFoundException('Commande introuvable.');
    if (order.userId !== user.id && user.role !== 'ADMIN') {
      throw new ForbiddenException('Accès refusé.');
    }

    return order;
  }

  /**
   * Récupère les commandes d'un client spécifique.
   */
  async findOrdersClient(page = 1, limit = 10, firebaseUid: string) {
    const user = await this.prisma.user.findUnique({ where: { firebaseUid } });
    if (!user) throw new NotFoundException('Utilisateur non trouvé.');

    const [orders, total] = await Promise.all([
      this.prisma.order.findMany({
        skip: (page - 1) * limit,
        take: limit,
        where: { userId: user.id, deleteCommande: false },
        include: {
          restaurant: { select: { nom: true, imageUrl: true, adresse: true } },
          items: {
            include: {
              product: {
                select: {
                  nom: true,
                  description: true,
                  imageUrl: true,
                },
              },
            },
          },
        },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.order.count({
        where: { userId: user.id, deleteCommande: false },
      }),
    ]);
    return {
      data: orders,
      meta: this.pagination.getPaginationMeta(page, limit, total),
    };
  }

  /**
   * Récupère les commandes d'un restaurant spécifique.
   * ADMIN voit toutes les commandes de tous les restaurants.
   */
  async findRestaurantOrders(firebaseUid: string) {
    const user = await this.prisma.user.findUnique({ where: { firebaseUid } });
    if (!user) throw new NotFoundException('Utilisateur non trouvé.');

    // Include commun pour les données utilisateur et items
    const include = {
      items: {
        include: { product: { select: { nom: true, imageUrl: true } } },
      },
      restaurant: { select: { nom: true } },
      user: {
        select: {
          id: true,
          nom: true,
          phone: true,
          email: true,
          imageUrl: true,
        },
      },
    };

    if (user.role === 'ADMIN') {
      // ADMIN : retourner toutes les commandes de tous les restaurants
      const orders = await this.prisma.order.findMany({
        include: include,
        orderBy: { createdAt: 'desc' },
      });
      return { data: orders };
    }

    // RESTAURATEUR : comportement actuel
    const restaurant = await this.prisma.restaurant.findFirst({
      where: { owner: { firebaseUid } },
    });

    if (!restaurant) {
      throw new NotFoundException(
        'Restaurant non trouvé pour cet utilisateur.',
      );
    }

    const orders = await this.prisma.order.findMany({
      where: { restaurantId: restaurant.id },
      include,
      orderBy: { createdAt: 'desc' },
    });

    return {
      data: orders,
    };
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
      include: { restaurant: true },
    });

    if (!order) {
      throw new NotFoundException('Commande non trouvée.');
    }

    if (order.userId !== user.id) {
      throw new ForbiddenException(
        "Vous n'êtes pas autorisé à annuler cette commande.",
      );
    }

    // Passe par la state machine — le CLIENT ne peut annuler que depuis EN_ATTENTE
    this.stateMachine.assertTransition(order.status, 'ANNULER', 'CLIENT');

    const updatedOrder = await this.prisma.order.update({
      where: { id: orderId },
      data: { status: 'ANNULER' },
      include: {
        restaurant: true,
        items: true, // Correction: Toujours inclure les items
      },
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

    // Liste des statuts que le restaurateur peut utiliser
    const allowedStatusUpdates: OrderStatus[] = [
      'PAYER',
      'EN_PREPARATION',
      'PRET',
      'EN_ROUTE',
      'LIVRER',
      'ANNULER',
    ];
    if (!allowedStatusUpdates.includes(newStatus)) {
      this.logger.warn(
        `🔄 [STATUT] Échec: statut invalide "${newStatus}" pour commande ${orderId}`,
      );
      throw new BadRequestException(
        `Statut de mise à jour invalide: ${newStatus}`,
      );
    }

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
          `Votre panier contient déjà des articles de ${currentCartItems[0].product.restaurantId}. Veuillez vider votre panier pour commander de ${order.restaurant.nom}.`,
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
  async findOrdersByUserId(userId: string) {
    // Méthode admin uniquement — pas de vérification d'appartenance
    const orders = await this.prisma.order.findMany({
      where: { userId, deleteCommande: false },
      include: {
        restaurant: { select: { nom: true, imageUrl: true, adresse: true } },
        items: {
          include: { product: { select: { nom: true, imageUrl: true } } },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    return { data: orders };
  }
}
