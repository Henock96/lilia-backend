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
    this.logger.log(`📦 [COMMANDE] Début création commande - user: ${firebaseUid}, payload: ${JSON.stringify({ adresseId: createOrderDto.adresseId, paymentMethod: createOrderDto.paymentMethod, isDelivery: createOrderDto.isDelivery })}`);

    const {
      adresseId,
      paymentMethod,
      notes,
      isDelivery = true,
    } = createOrderDto;

    const user = await this.prisma.user.findUnique({
      where: { firebaseUid },
      include: {
        cart: {
          include: {
            items: {
              include: {
                product: true,
                variant: true,
                menu: { select: { id: true, nom: true, prix: true } },
              },
            },
          },
        },
      },
    });

    if (!user) {
      this.logger.warn(`📦 [COMMANDE] Utilisateur introuvable: ${firebaseUid}`);
      throw new NotFoundException('Utilisateur non trouvé.');
    }
    this.logger.log(`📦 [COMMANDE] Utilisateur trouvé: ${user.id} (${user.nom || user.email}), panier: ${user.cart?.items?.length || 0} articles`);

    // 1. Vérifier l'adresse de livraison (seulement si c'est une livraison)
    let deliveryAddressString: string | null = null;

    if (isDelivery) {
      if (!adresseId) {
        this.logger.warn(`📦 [COMMANDE] Échec: adresse manquante pour livraison - user: ${user.id}`);
        throw new BadRequestException(
          'Une adresse de livraison est requise pour la livraison à domicile.',
        );
      }

      const deliveryAddress = await this.prisma.adresses.findUnique({
        where: { id: adresseId },
      });
      if (!deliveryAddress) {
        this.logger.warn(`📦 [COMMANDE] Échec: adresse ${adresseId} introuvable - user: ${user.id}`);
        throw new NotFoundException(
          "L'adresse de livraison spécifiée n'existe pas.",
        );
      }
      if (deliveryAddress.userId !== user.id) {
        this.logger.warn(`📦 [COMMANDE] Échec: adresse ${adresseId} n'appartient pas à user ${user.id}`);
        throw new ForbiddenException('Cette adresse ne vous appartient pas.');
      }

      // Formatter l'adresse pour le snapshot
      deliveryAddressString = `${deliveryAddress.rue}, ${deliveryAddress.ville}, ${deliveryAddress.country}`;
      this.logger.log(`📦 [COMMANDE] Adresse validée: ${deliveryAddressString}`);
    } else {
      this.logger.log(`📦 [COMMANDE] Mode retrait au restaurant`);
    }

    // 2. Vérifier le panier
    const cart = user.cart;
    if (!cart || cart.items.length === 0) {
      this.logger.warn(`📦 [COMMANDE] Échec: panier vide - user: ${user.id}`);
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

    // 3.1 Récupérer le restaurant et vérifier s'il est ouvert
    const restaurant = await this.prisma.restaurant.findUnique({
      where: { id: firstItemRestaurantId },
    });

    if (!restaurant) {
      this.logger.warn(`📦 [COMMANDE] Échec: restaurant ${firstItemRestaurantId} introuvable`);
      throw new NotFoundException('Restaurant non trouvé.');
    }

    this.logger.log(`📦 [COMMANDE] Restaurant: ${restaurant.nom} (${restaurant.id}), ouvert: ${restaurant.isOpen}`);

    // Vérifier si le restaurant est ouvert
    if (!restaurant.isOpen) {
      this.logger.warn(`📦 [COMMANDE] Échec: restaurant "${restaurant.nom}" fermé - user: ${user.id}`);
      throw new BadRequestException(
        `Le restaurant "${restaurant.nom}" est actuellement fermé et n'accepte pas de commandes.`,
      );
    }

    // 3.2 Vérifier le stock des produits et menus
    const outOfStockItems: string[] = [];
    for (const item of cartItems) {
      const product = await this.prisma.product.findUnique({
        where: { id: item.productId },
      });
      if (product && product.stockRestant !== null && product.stockRestant < item.quantite) {
        outOfStockItems.push(
          product.stockRestant === 0
            ? `"${product.nom}" est épuisé`
            : `"${product.nom}" : seulement ${product.stockRestant} restant(s)`,
        );
      }
      if (item.menuId) {
        const menu = await this.prisma.menuDuJour.findUnique({
          where: { id: item.menuId },
        });
        if (menu && menu.stockRestant !== null && menu.stockRestant < item.quantite) {
          outOfStockItems.push(
            menu.stockRestant === 0
              ? `Menu "${menu.nom}" est épuisé`
              : `Menu "${menu.nom}" : seulement ${menu.stockRestant} restant(s)`,
          );
        }
      }
    }
    if (outOfStockItems.length > 0) {
      this.logger.warn(`📦 [COMMANDE] Échec: rupture de stock - user: ${user.id}, items: ${outOfStockItems.join(', ')}`);
      throw new BadRequestException(
        `Produits en rupture de stock : ${outOfStockItems.join(', ')}`,
      );
    }

    // 4. Calculer les montants
    // Grouper les items par menuId pour utiliser le prix du menu
    const menuGroups = new Map<string, typeof cartItems>();
    const individualItems: typeof cartItems = [];

    for (const item of cartItems) {
      if (item.menuId && item.menu) {
        if (!menuGroups.has(item.menuId)) {
          menuGroups.set(item.menuId, []);
        }
        menuGroups.get(item.menuId)!.push(item);
      } else {
        individualItems.push(item);
      }
    }

    // Sous-total des produits individuels
    let subTotal = individualItems.reduce((total, item) => {
      return total + item.variant.prix * item.quantite;
    }, 0);

    // Sous-total des menus (prix du menu * quantité du premier item du groupe)
    for (const [, groupItems] of menuGroups) {
      const menuPrix = groupItems[0].menu!.prix;
      const quantite = groupItems[0].quantite;
      subTotal += menuPrix * quantite;
    }

    this.logger.log(`📦 [COMMANDE] Calcul montant - sous-total: ${subTotal} FCFA, items individuels: ${individualItems.length}, menus: ${menuGroups.size}`);

    // 4.1 Vérifier le montant minimum de commande
    if (
      restaurant.minimumOrderAmount > 0 &&
      subTotal < restaurant.minimumOrderAmount
    ) {
      this.logger.warn(`📦 [COMMANDE] Échec: montant minimum non atteint - user: ${user.id}, sous-total: ${subTotal}, minimum: ${restaurant.minimumOrderAmount}`);
      throw new BadRequestException(
        `Le montant minimum de commande pour ce restaurant est de ${restaurant.minimumOrderAmount} FCFA. Votre panier actuel: ${subTotal} FCFA.`,
      );
    }

    // Frais de livraison: appliqués seulement si c'est une livraison à domicile
    // Utilise le prix fixe du restaurant ou le prix par défaut
    const deliveryFee = isDelivery ? restaurant.fixedDeliveryFee : 0;
    const total = subTotal + deliveryFee;
    this.logger.log(`📦 [COMMANDE] Total calculé: ${total} FCFA (sous-total: ${subTotal} + livraison: ${deliveryFee})`);

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
            create: cartItems.map((item, index) => {
              // Pour les items de menu: le premier item du groupe porte le prix menu, les autres 0
              let prix = item.variant.prix;
              if (item.menuId && item.menu) {
                const isFirstInGroup = cartItems.findIndex(
                  (ci) => ci.menuId === item.menuId,
                ) === index;
                prix = isFirstInGroup ? item.menu.prix : 0;
              }
              return {
                productId: item.productId,
                menuId: item.menuId || undefined,
                quantite: item.quantite,
                prix,
                variant: item.variant.label || 'Standard',
              };
            }),
          },
        },
        include: {
          items: true,
          restaurant: true, // Correction: Toujours inclure le restaurant
        },
      });

      // 6. Décrémenter le stock des produits et menus commandés
      const decrementedProductIds = new Set<string>();
      const decrementedMenuIds = new Set<string>();
      for (const item of cartItems) {
        if (!decrementedProductIds.has(item.productId)) {
          const prod = await tx.product.findUnique({ where: { id: item.productId } });
          if (prod && prod.stockRestant !== null) {
            await tx.product.update({
              where: { id: item.productId },
              data: { stockRestant: Math.max(0, prod.stockRestant - item.quantite) },
            });
          }
          decrementedProductIds.add(item.productId);
        }
        if (item.menuId && !decrementedMenuIds.has(item.menuId)) {
          const menu = await tx.menuDuJour.findUnique({ where: { id: item.menuId } });
          if (menu && menu.stockRestant !== null) {
            await tx.menuDuJour.update({
              where: { id: item.menuId },
              data: { stockRestant: Math.max(0, menu.stockRestant - item.quantite) },
            });
          }
          decrementedMenuIds.add(item.menuId);
        }
      }

      // 7. Vider le panier
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
   * ADMIN voit toutes les commandes de tous les restaurants.
   */
  async findRestaurantOrders(firebaseUid: string) {
    const user = await this.prisma.user.findUnique({ where: { firebaseUid } });
    if (!user) throw new NotFoundException('Utilisateur non trouvé.');

    // Include commun pour les données utilisateur et items
    const orderInclude = {
      items: { include: { product: { select: { nom: true, imageUrl: true } } } },
      restaurant: { select: { nom: true } },
      user: { select: { id: true, nom: true, phone: true, email: true, imageUrl: true } },
    };

    if (user.role === 'ADMIN') {
      // ADMIN : retourner toutes les commandes de tous les restaurants
      const orders = await this.prisma.order.findMany({
        include: orderInclude,
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
      include: orderInclude,
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
    this.logger.log(`🔄 [STATUT] Début mise à jour - commande: ${orderId}, nouveau statut: ${newStatus}, par: ${firebaseUid}`);

    const user = await this.prisma.user.findUnique({ where: { firebaseUid } });
    if (!user || (user.role !== 'RESTAURATEUR' && user.role !== 'ADMIN')) {
      this.logger.warn(`🔄 [STATUT] Échec: accès refusé - user: ${firebaseUid}, rôle: ${user?.role || 'inconnu'}`);
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
    this.logger.log(`🔄 [STATUT] Commande trouvée: ${orderId}, statut actuel: ${order.status}, client: ${order.userId}, restaurant: ${order.restaurant.nom}`);
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
      'LIVRER',
      'ANNULER',
    ];
    if (!allowedStatusUpdates.includes(newStatus)) {
      this.logger.warn(`🔄 [STATUT] Échec: statut invalide "${newStatus}" pour commande ${orderId}`);
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
    this.logger.log(`🔄 [STATUT] Succès: commande ${orderId} - ${order.status} → ${newStatus} (par ${user.id}/${user.role})`);
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

  /**
   * Invalide les commandes EN_ATTENTE contenant des produits en rupture de stock.
   * Passe ces commandes en ANNULER et notifie le client.
   */
  async invalidateOutOfStockOrders() {
    // Trouver les commandes en attente dont au moins un produit a stockRestant == 0
    const pendingOrders = await this.prisma.order.findMany({
      where: {
        status: 'EN_ATTENTE',
        items: {
          some: {
            product: {
              stockRestant: 0,
            },
          },
        },
      },
      include: {
        items: { include: { product: { select: { nom: true, stockRestant: true } } } },
        restaurant: true,
      },
    });

    for (const order of pendingOrders) {
      const outOfStock = order.items
        .filter((item) => item.product.stockRestant === 0)
        .map((item) => item.product.nom);

      await this.prisma.order.update({
        where: { id: order.id },
        data: { status: 'ANNULER' },
      });

      const cancelledEvent = new OrderCancelledEvent(
        order.id,
        order.userId,
        order.restaurantId,
        'Système',
        `Produits en rupture de stock : ${outOfStock.join(', ')}`,
        0,
      );
      this.eventEmitter.emit('order.cancelled', cancelledEvent);

      this.logger.log(
        `Commande ${order.id} annulée (rupture de stock: ${outOfStock.join(', ')})`,
      );
    }

    return { cancelled: pendingOrders.length };
  }

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
          (v) => v.label === orderItem.variant,
        );

        // Si la variante n'existe plus, prendre la première disponible
        if (!variant && product.variants.length > 0) {
          variant = product.variants[0];
          this.logger.warn(
            `Variant "${orderItem.variant}" not found for product ${product.id}, using default variant`,
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
}
