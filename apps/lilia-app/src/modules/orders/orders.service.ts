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
import { ConfigService } from '@nestjs/config';
import { PlatformSettingsService } from '../platform-settings/platform-settings.service';
import { PreorderValidatorService } from '../vendors/preorder-validator.service';
import Redis from 'ioredis';

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);
  private readonly redis: Redis;

  constructor(
    private prisma: PrismaService,
    private eventEmitter: EventEmitter2,
    private readonly pagination: PaginationService,
    private readonly stateMachine: OrderStateMachine,
    private readonly stockService: StockService,
    private readonly validator: OrderValidatorService,
    private readonly calculator: OrderCalculatorService,
    private readonly promoService: PromoService,
    private readonly config: ConfigService,
    private readonly platformSettings: PlatformSettingsService,
    private readonly preorderValidator: PreorderValidatorService,
  ) {
    const redisUrl = this.config.get<string>('REDIS_URL');
    this.redis = redisUrl ? new Redis(redisUrl) : null as any;
  }

  /**
   * Crée une commande à partir du panier de l'utilisateur.
   * Utilise une transaction pour garantir l'intégrité des données.
   */
  private async handleReferralReward(userId: string): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { referredByCode: true, referralRewarded: true },
    });
    if (!user?.referredByCode || user.referralRewarded) return;

    const orderCount = await this.prisma.order.count({ where: { userId } });
    if (orderCount !== 1) return;

    const referrer = await this.prisma.user.findUnique({
      where: { referralCode: user.referredByCode },
      select: { id: true },
    });
    if (!referrer) return;

    const settings = await this.platformSettings.getSettings();

    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: referrer.id },
        data: { loyaltyPoints: { increment: settings.referrerBonusPoints } },
      }),
      this.prisma.loyaltyTransaction.create({
        data: { userId: referrer.id, points: settings.referrerBonusPoints, reason: 'Récompense parrainage — filleul activé' },
      }),
      this.prisma.user.update({
        where: { id: userId },
        data: { loyaltyPoints: { increment: settings.referredBonusPoints }, referralRewarded: true },
      }),
      this.prisma.loyaltyTransaction.create({
        data: { userId, points: settings.referredBonusPoints, reason: 'Bonus bienvenue parrainage' },
      }),
    ]);

    this.logger.log(`🎁 Parrainage: +${settings.referrerBonusPoints}pts → parrain ${referrer.id}, +${settings.referredBonusPoints}pts → filleul ${userId}`);
  }

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
    const {
      adresseId,
      paymentMethod,
      notes,
      isDelivery = true,
      contactPhone,
      promoCode,
      useLoyaltyPoints,
      deliveryLatitude,
      deliveryLongitude,
      isPreorder,
      scheduledFor,
    } = dto;
    const scheduledForDate = scheduledFor ? new Date(scheduledFor) : null;
    // Idempotency check — évite les doublons sur double-tap ou retry réseau
    if (idempotencyKey && this.redis) {
      const cacheKey = `idempotency:${firebaseUid}:${idempotencyKey}`;
      const cached = await this.redis.get(cacheKey);
      if (cached) {
        this.logger.log(`📦 [IDEMPOTENCY] Réponse cachée retournée — key: ${idempotencyKey}`);
        return JSON.parse(cached);
      }
    }

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

    // Multi-vendeurs (LIL-112 + LIL-121 décision 1b)
    // Validation pilotée par les items du panier : preorder requis ssi au moins
    // un produit a `madeToOrder=true`, et rejet du mix immédiat/sur commande.
    this.preorderValidator.validatePreorderForCart(
      cartItems,
      restaurant,
      scheduledForDate,
    );
    await this.preorderValidator.validateDailyCapacity(restaurant);

    // 2. Calcul — isolé, testable unitairement
    const settings = await this.platformSettings.getSettings();
    const amounts = this.calculator.calculate(
      cartItems,
      restaurant.fixedDeliveryFee,
      isDelivery,
      settings.serviceFeePercent,
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

    // Réduction points de fidélité
    //
    // SÉCURITÉ (fix B4) : on plafonne `loyaltyDiscount` au montant restant
    // à payer après promo. Sans ce cap, un client pouvait consommer
    // 10 000 pts (= 50 000 FCFA de valeur) sur une commande de 500 FCFA :
    // l'ordre tombait à 0 mais les points étaient brûlés en totalité.
    // `pointsUsed` est recalculé en conséquence (Math.ceil pour ne pas
    // créditer une fraction de point gratuite).
    let loyaltyDiscount = 0;
    if (useLoyaltyPoints) {
      const userPoints = await this.prisma.user.findUnique({
        where: { id: user.id },
        select: { loyaltyPoints: true },
      });
      const pts = userPoints?.loyaltyPoints ?? 0;
      if (pts >= settings.loyaltyMinRedemption) {
        const requested = pts * settings.loyaltyPointValueXaf;
        const totalBeforeLoyalty = Math.max(
          0,
          amounts.subTotal + finalDeliveryFee + amounts.serviceFee - discountAmount,
        );
        loyaltyDiscount = Math.min(requested, totalBeforeLoyalty);
      }
    }

    const finalTotal = Math.max(0, amounts.subTotal + finalDeliveryFee + amounts.serviceFee - discountAmount - loyaltyDiscount);
    // 5. Exécuter la création de la commande et la suppression du panier dans une transaction
    const order = await this.prisma.$transaction(async (tx) => {
      const newOrder = await tx.order.create({
        data: {
          userId: user.id,
          restaurantId,
          subTotal: amounts.subTotal,
          deliveryFee: finalDeliveryFee,
          serviceFee: amounts.serviceFee,
          discountAmount: discountAmount + loyaltyDiscount,
          total: finalTotal,
          promoCodeId: promoResult?.promoCodeId ?? null,
          isDelivery,
          notes,
          contactPhone,
          deliveryAddress,
          deliveryLatitude: deliveryLatitude ?? null,
          deliveryLongitude: deliveryLongitude ?? null,
          paymentMethod,
          status: 'EN_ATTENTE',
          isPreorder: isPreorder ?? Boolean(scheduledForDate),
          scheduledFor: scheduledForDate,
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
      // Consomme le code promo dans la transaction
      if (promoResult) {
        await this.promoService.applyCode(
          tx,
          promoResult.promoCodeId,
          user.id,
          newOrder.id,
          discountAmount,
        );
      }

      // Consomme les points de fidélité dans la transaction
      if (useLoyaltyPoints && loyaltyDiscount > 0) {
        const pointsUsed = Math.ceil(loyaltyDiscount / settings.loyaltyPointValueXaf);
        await tx.user.update({
          where: { id: user.id },
          data: { loyaltyPoints: { decrement: pointsUsed } },
        });
        await tx.loyaltyTransaction.create({
          data: {
            userId: user.id,
            orderId: newOrder.id,
            points: -pointsUsed,
            reason: `${pointsUsed} pts utilisés — réduction ${loyaltyDiscount} FCFA`,
          },
        });
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

    // Récompense parrainage sur la 1ère commande (non-bloquant)
    this.handleReferralReward(user.id).catch((err) =>
      this.logger.error(`Erreur récompense parrainage: ${err}`),
    );

    const result = { message: 'Commande créée avec succès.', data: order };

    // Cache idempotency result — TTL 1h
    if (idempotencyKey && this.redis) {
      const cacheKey = `idempotency:${firebaseUid}:${idempotencyKey}`;
      await this.redis.setex(cacheKey, 3600, JSON.stringify(result)).catch(() => {});
    }

    return result;
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
  async findRestaurantOrders(firebaseUid: string, page = 1, limit = 20) {
    const user = await this.prisma.user.findUnique({ where: { firebaseUid } });
    if (!user) throw new NotFoundException('Utilisateur non trouvé.');

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
      const [orders, total] = await Promise.all([
        this.prisma.order.findMany({
          include,
          orderBy: { createdAt: 'desc' },
          skip: (page - 1) * limit,
          take: limit,
        }),
        this.prisma.order.count(),
      ]);
      return {
        data: orders,
        meta: this.pagination.getPaginationMeta(page, limit, total),
      };
    }

    // RESTAURATEUR : ses commandes uniquement
    const restaurant = await this.prisma.restaurant.findFirst({
      where: { owner: { firebaseUid } },
    });

    if (!restaurant) {
      throw new NotFoundException('Restaurant non trouvé pour cet utilisateur.');
    }

    const [orders, total] = await Promise.all([
      this.prisma.order.findMany({
        where: { restaurantId: restaurant.id },
        include,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.order.count({ where: { restaurantId: restaurant.id } }),
    ]);

    return {
      data: orders,
      meta: this.pagination.getPaginationMeta(page, limit, total),
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

    // SÉCURITÉ (fix B9) : on restaure le stock décrémenté au checkout.
    // Stock illimité (stockRestant === null) → laissé tel quel par
    // StockService.restoreInTransaction. Order.status est mis à jour
    // dans la même transaction pour garantir l'atomicité — pas de
    // double-restock possible si on retente.
    const updatedOrder = await this.prisma.$transaction(async (tx) => {
      await this.stockService.restoreInTransaction(
        tx,
        order.items.map((item) => ({
          productId: item.productId,
          menuId: item.menuId,
          quantite: item.quantite,
        })),
      );
      return tx.order.update({
        where: { id: orderId },
        data: { status: 'ANNULER' },
        include: {
          restaurant: true,
          items: true,
        },
      });
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
  /**
   * Liste les commandes d'un user — réservé ADMIN.
   *
   * SÉCURITÉ (fix B3) : defense-in-depth — on revérifie le rôle ADMIN
   * de l'appelant DANS le service, même si le controller a déjà
   * `@Roles('ADMIN')`. Évite qu'une future modification du controller
   * (ou un appel inter-service) ne bypasse le contrôle d'accès.
   */
  async findOrdersByUserId(userId: string, callerFirebaseUid: string) {
    const caller = await this.prisma.user.findUnique({
      where: { firebaseUid: callerFirebaseUid },
      select: { role: true },
    });
    if (!caller || caller.role !== 'ADMIN') {
      throw new ForbiddenException('Accès réservé aux administrateurs.');
    }

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
