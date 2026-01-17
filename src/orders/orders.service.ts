import {
  BadRequestException,
  Injectable,
  NotFoundException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { OrderStatus } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  OrderCancelledEvent,
  OrderCreatedEvent,
  OrderStatusUpdatedEvent,
} from 'src/events/order-events';
import { PaginationService } from 'src/common/pagination/pagination.service';

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);
  constructor(
    private prisma: PrismaService,
    private eventEmitter: EventEmitter2,
    private readonly pagination: PaginationService,
  ) {}

  /**
   * Crée une commande à partir du panier de l'utilisateur.
   * Utilise une transaction pour garantir l'intégrité des données.
   */
  async createOrderFromCart(
    firebaseUid: string,
    createOrderDto: CreateOrderDto,
  ) {
    const { adresseId, paymentMethod, notes, isDelivery = true } = createOrderDto;

    const user = await this.prisma.user.findUnique({
      where: { firebaseUid },
      include: {
        cart: {
          include: {
            items: {
              include: {
                product: true,
                variant: true,
              },
            },
          },
        },
      },
    });

    if (!user) {
      throw new NotFoundException('Utilisateur non trouvé.');
    }

    // 1. Vérifier l'adresse de livraison (seulement si c'est une livraison)
    let deliveryAddressString: string | null = null;

    if (isDelivery) {
      if (!adresseId) {
        throw new BadRequestException(
          'Une adresse de livraison est requise pour la livraison à domicile.',
        );
      }

      const deliveryAddress = await this.prisma.adresses.findUnique({
        where: { id: adresseId },
      });
      if (!deliveryAddress) {
        throw new NotFoundException(
          "L'adresse de livraison spécifiée n'existe pas.",
        );
      }
      if (deliveryAddress.userId !== user.id) {
        throw new ForbiddenException('Cette adresse ne vous appartient pas.');
      }

      // Formatter l'adresse pour le snapshot
      deliveryAddressString = `${deliveryAddress.rue}, ${deliveryAddress.ville}, ${deliveryAddress.country}`;
    }

    // 2. Vérifier le panier
    const cart = user.cart;
    if (!cart || cart.items.length === 0) {
      throw new BadRequestException('Votre panier est vide.');
    }

    const cartItems = cart.items;
    const firstItemRestaurantId = cartItems[0].product.restaurantId;

    // 3. Vérifier que tous les articles proviennent du même restaurant
    const allItemsFromSameRestaurant = cartItems.every(
      (item) => item.product.restaurantId === firstItemRestaurantId,
    );
    if (!allItemsFromSameRestaurant) {
      throw new BadRequestException(
        'Tous les articles de votre panier doivent provenir du même restaurant.',
      );
    }

    // 4. Calculer les montants
    const subTotal = cartItems.reduce((total, item) => {
      return total + item.variant.prix * item.quantite;
    }, 0);

    // Frais de livraison: appliqués seulement si c'est une livraison à domicile
    const deliveryFee = isDelivery ? parseFloat(process.env.DELIVERY_FEE || '500') : 0;
    const total = subTotal + deliveryFee;

    // 5. Exécuter la création de la commande et la suppression du panier dans une transaction
    const order = await this.prisma.$transaction(async (tx) => {
      const newOrder = await tx.order.create({
        data: {
          userId: user.id,
          restaurantId: firstItemRestaurantId,
          subTotal,
          deliveryFee,
          total,
          isDelivery,
          notes,
          deliveryAddress: deliveryAddressString,
          paymentMethod,
          status: 'EN_ATTENTE',
          items: {
            create: cartItems.map((item) => ({
              productId: item.productId,
              quantite: item.quantite,
              prix: item.variant.prix,
              variant: item.variant.label || 'Standard',
            })),
          },
        },
        include: {
          items: true,
          restaurant: true, // Correction: Toujours inclure le restaurant
        },
      });

      // 6. Vider le panier
      await tx.cartItem.deleteMany({
        where: {
          cartId: cart.id,
        },
      });

      return newOrder;
    });
    this.logger.log(
      `🔔 Nouvelles commandes: ${order.userId} a passé une commande ${order.id} au restaurant ${order.restaurantId} pour un total de ${order.total} FCFA.`,
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
   * Récupère les commandes d'un client spécifique.
   */
  async findOrdersClient(page = 1, limit = 10, firebaseUid: string) {
    const user = await this.prisma.user.findUnique({ where: { firebaseUid } });
    if (!user) throw new NotFoundException('Utilisateur non trouvé.');

    const orders = await this.prisma.order.findMany({
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
    });

    const totalOrders = await this.prisma.order.count({
      where: { userId: user.id },
    });
    const meta = this.pagination.getPaginationMeta(page, limit, totalOrders);

    return {
      data: orders,
      meta,
    };
  }

  /**
   * Récupère les commandes d'un restaurant spécifique.
   */
  async findRestaurantOrders(firebaseUid: string) {
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
      include: {
        items: { include: { product: { select: { nom: true } } } },
      },
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

    if (order.status !== 'EN_ATTENTE') {
      throw new BadRequestException(
        'Cette commande ne peut plus être annulée.',
      );
    }

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
    console.log('🔵 === DÉBUT UPDATE ORDER STATUS ===');
    console.log('🔵 Order ID:', orderId);
    console.log('🔵 Firebase UID:', firebaseUid);
    console.log('🔵 New Status:', newStatus);

    const user = await this.prisma.user.findUnique({ where: { firebaseUid } });
    if (!user || user.role !== 'RESTAURATEUR') {
      throw new ForbiddenException(
        "Vous n'êtes pas autorisé à effectuer cette action.",
      );
    }
    console.log('🔵 Restaurateur found:', user.id);
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { restaurant: true },
    });

    if (!order) {
      throw new NotFoundException('Commande non trouvée.');
    }
    console.log('🔵 Order found for user:', order.userId);
    if (order.restaurant.ownerId !== user.id) {
      throw new ForbiddenException(
        "Cette commande n'appartient pas à votre restaurant.",
      );
    }

    // Ici, vous pourriez ajouter une logique de machine à états pour valider les transitions.
    // Par exemple, un restaurateur ne peut pas passer une commande à 'LIVRER'.
    const allowedStatusUpdates: OrderStatus[] = [
      'PAYER',
      'PRET',
      'LIVRER',
      'ANNULER',
    ];
    if (!allowedStatusUpdates.includes(newStatus)) {
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
      updatedOrder.status,
      newStatus,
      user.id, // updatedBy
      {
        restaurantName: updatedOrder.restaurant.nom,
        totalAmount: updatedOrder.total,
      },
    );

    this.eventEmitter.emit('order.status.updated', statusUpdatedEvent);
    return updatedOrder;
  }

  /**
   * Recommande (reorder) une commande précédente.
   * Ajoute tous les produits de la commande au panier actuel.
   */
  async reorderFromPreviousOrder(orderId: string, firebaseUid: string) {
    // 1. Vérifier l'utilisateur
    const user = await this.prisma.user.findUnique({
      where: { firebaseUid },
      include: { cart: true }
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
      throw new ForbiddenException(
        "Cette commande ne vous appartient pas.",
      );
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

    for (const orderItem of order.items) {
      try {
        // Vérifier que le produit existe toujours
        const product = orderItem.product;
        if (!product) {
          results.unavailable.push({
            productId: orderItem.productId,
            reason: 'Produit introuvable',
          });
          continue;
        }

        // Trouver la variante correspondante
        // On cherche par label ou on prend la première variante disponible
        let variant = product.variants.find(
          (v) => v.label === orderItem.variant
        );

        // Si la variante n'existe plus, prendre la première disponible
        if (!variant && product.variants.length > 0) {
          variant = product.variants[0];
          this.logger.warn(
            `Variant "${orderItem.variant}" not found for product ${product.id}, using default variant`
          );
        }

        if (!variant) {
          results.unavailable.push({
            productName: product.nom,
            reason: 'Aucune variante disponible',
          });
          continue;
        }

        // Vérifier si l'item existe déjà dans le panier
        const existingCartItem = await this.prisma.cartItem.findUnique({
          where: {
            cartId_variantId: {
              cartId: cart.id,
              variantId: variant.id,
            },
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
          error
        );
        results.errors.push({
          productId: orderItem.productId,
          error: error.message,
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
                restaurantId: true
              },
            },
            variant: {
              select: {
                label: true,
                prix: true
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
}
