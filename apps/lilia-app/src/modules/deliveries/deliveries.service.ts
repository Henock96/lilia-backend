/* eslint-disable prettier/prettier */
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { DeliveryStatus } from './dto/update-delivery.dto';
import { DriverStatus, OrderStatus } from '@prisma/client';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { NotificationsService } from '../notifications/notifications.service';
import { OrderStateMachine } from '../orders/order-state.machine';
import { OrderStatusUpdatedEvent } from '../events/order-events';
import { PlatformSettingsService } from '../platform-settings/platform-settings.service';

type ActorRole = 'CLIENT' | 'RESTAURATEUR' | 'ADMIN' | 'LIVREUR';

@Injectable()
export class DeliveriesService {
  private readonly logger = new Logger(DeliveriesService.name);

  constructor(
    private prisma: PrismaService,
    private readonly notificationsService: NotificationsService,
    private readonly eventEmitter: EventEmitter2,
    private readonly stateMachine: OrderStateMachine,
    private readonly platformSettings: PlatformSettingsService,
  ) {}

  private resolveActor(role: string): ActorRole | null {
    const map: Record<string, ActorRole> = {
      CLIENT: 'CLIENT',
      RESTAURATEUR: 'RESTAURATEUR',
      ADMIN: 'ADMIN',
      LIVREUR: 'LIVREUR',
    };
    return map[role] ?? null;
  }

  /**
   * Crédite +1pt par 100 FCFA de subTotal à la livraison.
   * Aligné avec OrdersService.awardLoyaltyPoints (non-bloquant).
   */
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

    this.logger.log(`⭐ +${points} points fidélité user ${userId} (commande ${orderId})`);
  }

  /**
   * Récupère toutes les livraisons pour un restaurant
   */
  async findAllForRestaurant(firebaseUid: string, status?: DeliveryStatus, page = 1, limit = 20) {
    // Trouver le restaurant de l'utilisateur
    const restaurant = await this.prisma.restaurant.findFirst({
      where: { owner: { firebaseUid } },
    });

    if (!restaurant) {
      throw new ForbiddenException('Vous devez posséder un restaurant.');
    }

    const where: any = {
      order: {
        restaurantId: restaurant.id,
      },
    };

    if (status) {
      where.status = status;
    }

    const [deliveries, total] = await Promise.all([
      this.prisma.delivery.findMany({
        where,
        include: {
          order: {
            include: {
              items: {
                include: {
                  product: true,
                },
              },
            },
          },
          deliverer: {
            select: {
              id: true,
              nom: true,
              phone: true,
              imageUrl: true,
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.delivery.count({ where }),
    ]);

    return {
      data: deliveries,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * Récupère les livraisons assignées à un livreur
   */
  async findAllForDeliverer(firebaseUid: string, status?: DeliveryStatus) {
    const user = await this.prisma.user.findUnique({
      where: { firebaseUid },
    });

    if (!user) {
      throw new NotFoundException('Utilisateur non trouvé.');
    }

    const where: any = {
      delivererId: user.id,
    };

    if (status) {
      where.status = status;
    }

    const deliveries = await this.prisma.delivery.findMany({
      where,
      include: {
        order: {
          include: {
            user: {
              select: { nom: true, phone: true },
            },
            restaurant: {
              select: {
                id: true,
                nom: true,
                adresse: true,
                phone: true,
              },
            },
            items: {
              include: {
                product: true,
              },
            },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    return {
      data: deliveries,
      count: deliveries.length,
    };
  }

  /**
   * Récupère une livraison par son ID
   */
  async findOne(id: string) {
    const delivery = await this.prisma.delivery.findUnique({
      where: { id },
      include: {
        order: {
          include: {
            user: {
              select: { nom: true, phone: true },
            },
            restaurant: {
              select: {
                id: true,
                nom: true,
                adresse: true,
                phone: true,
              },
            },
            items: {
              include: {
                product: true,
              },
            },
          },
        },
        deliverer: {
          select: {
            id: true,
            nom: true,
            phone: true,
            imageUrl: true,
          },
        },
      },
    });

    if (!delivery) {
      throw new NotFoundException(`Livraison avec l'ID "${id}" non trouvée.`);
    }

    return {
      data: delivery,
    };
  }

  /**
   * Met à jour le statut d'une livraison.
   *
   * Quand status = LIVRER :
   *  - Vérifie la transition Order EN_ROUTE → LIVRER via state machine
   *  - Met à jour Order.status, Delivery.deliveredAt, User.driverStatus = AVAILABLE
   *  - Émet `order.status.updated` → FCM client + broadcast WebSocket
   *  - Crédite les points fidélité (1pt/100 FCFA subTotal)
   *
   * Quand status = ECHEC :
   *  - Marque la livraison en échec, libère le livreur (DriverStatus = AVAILABLE)
   *  - La commande n'est PAS auto-annulée — l'admin/restaurateur doit décider
   */
  async updateStatus(id: string, status: DeliveryStatus, firebaseUid: string) {
    const delivery = await this.prisma.delivery.findUnique({
      where: { id },
      include: {
        order: {
          include: {
            restaurant: { include: { owner: true } },
          },
        },
        deliverer: true,
      },
    });

    if (!delivery) {
      throw new NotFoundException(`Livraison avec l'ID "${id}" non trouvée.`);
    }

    const user = await this.prisma.user.findUnique({ where: { firebaseUid } });
    if (!user) throw new NotFoundException('Utilisateur non trouvé.');

    const isRestaurantOwner = delivery.order.restaurant.owner.firebaseUid === firebaseUid;
    const isAssignedDeliverer = delivery.delivererId === user.id;
    const isAdmin = user.role === 'ADMIN';

    if (!isRestaurantOwner && !isAssignedDeliverer && !isAdmin) {
      throw new ForbiddenException("Vous n'êtes pas autorisé à modifier cette livraison.");
    }

    // Si LIVRER : valide la transition Order via state machine
    if (status === DeliveryStatus.LIVRER) {
      const actor = this.resolveActor(user.role);
      if (!actor) throw new ForbiddenException('Acteur invalide pour cette transition.');
      this.stateMachine.assertTransition(delivery.order.status, OrderStatus.LIVRER, actor);
    }

    const now = new Date();
    const previousOrderStatus = delivery.order.status;

    // Update atomique : Delivery + Order + DriverStatus
    const operations: any[] = [
      this.prisma.delivery.update({
        where: { id },
        data: {
          status,
          ...(status === DeliveryStatus.LIVRER ? { deliveredAt: now } : {}),
        },
      }),
    ];

    if (status === DeliveryStatus.LIVRER) {
      operations.push(
        this.prisma.order.update({
          where: { id: delivery.orderId },
          data: { status: OrderStatus.LIVRER },
        }),
      );
    }

    // Libère le livreur dans les 2 cas (LIVRER ou ECHEC)
    if ((status === DeliveryStatus.LIVRER || status === DeliveryStatus.ECHEC) && delivery.delivererId) {
      operations.push(
        this.prisma.user.update({
          where: { id: delivery.delivererId },
          data: { driverStatus: DriverStatus.AVAILABLE },
        }),
      );
    }

    await this.prisma.$transaction(operations);

    const updated = await this.prisma.delivery.findUnique({
      where: { id },
      include: {
        order: true,
        deliverer: { select: { id: true, nom: true, phone: true } },
      },
    });

    // Émet l'event order.status.updated → OrdersListener notifie le client + WS
    if (status === DeliveryStatus.LIVRER) {
      const statusEvent = new OrderStatusUpdatedEvent(
        delivery.orderId,
        delivery.order.userId,
        delivery.order.restaurantId,
        previousOrderStatus,
        OrderStatus.LIVRER,
        user.id,
        {
          restaurantName: delivery.order.restaurant.nom,
          totalAmount: delivery.order.total,
        },
      );
      this.eventEmitter.emit('order.status.updated', statusEvent);

      // Crédite les points fidélité (non-bloquant)
      this.awardLoyaltyPoints(
        delivery.order.userId,
        delivery.orderId,
        delivery.order.subTotal,
      ).catch((err) => this.logger.error(`Erreur points fidélité: ${err}`));
    }

    return { data: updated, message: 'Statut de livraison mis à jour' };
  }

  /**
   * Assigne un livreur via l'ID de livraison (doit déjà exister)
   */
  async assignDeliverer(id: string, delivererId: string, firebaseUid: string) {
    const delivery = await this.prisma.delivery.findUnique({
      where: { id },
      include: {
        order: { include: { restaurant: { include: { owner: true } } } },
      },
    });

    if (!delivery) {
      throw new NotFoundException(`Livraison avec l'ID "${id}" non trouvée.`);
    }

    return this._doAssign(delivery, delivererId, firebaseUid);
  }

  /**
   * Assigne un livreur via l'ID de commande (crée la livraison si elle n'existe pas)
   */
  async assignDelivererToOrder(orderId: string, delivererId: string, firebaseUid: string) {
    const user = await this.getUserOrThrow(firebaseUid);

    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { restaurant: { include: { owner: true } } },
    });

    if (!order) throw new NotFoundException('Commande non trouvée.');

    const isRestaurantOwner = order.restaurant.owner.firebaseUid === firebaseUid;
    const isAdmin = user.role === 'ADMIN';
    if (!isRestaurantOwner && !isAdmin) {
      throw new ForbiddenException("Vous n'êtes pas autorisé à assigner un livreur à cette commande.");
    }

    // Trouver ou créer l'enregistrement Delivery
    let delivery = await this.prisma.delivery.findUnique({ where: { orderId } });
    if (!delivery) {
      delivery = await this.prisma.delivery.create({
        data: { orderId, status: 'EN_ATTENTE' },
      });
    }

    // Recharger avec les relations nécessaires à _doAssign
    const deliveryFull = await this.prisma.delivery.findUnique({
      where: { id: delivery.id },
      include: { order: { include: { restaurant: { include: { owner: true } } } } },
    });

    return this._doAssign(deliveryFull!, delivererId, firebaseUid);
  }

  private async _doAssign(
    delivery: any,
    delivererId: string,
    firebaseUid: string,
  ) {
    const user = await this.getUserOrThrow(firebaseUid);
    const isRestaurantOwner = delivery.order.restaurant.owner.firebaseUid === firebaseUid;
    const isAdmin = user.role === 'ADMIN';

    if (!isRestaurantOwner && !isAdmin) {
      throw new ForbiddenException("Vous n'êtes pas autorisé à assigner un livreur à cette livraison.");
    }

    const deliverer = await this.prisma.user.findUnique({ where: { id: delivererId } });
    if (!deliverer) throw new NotFoundException('Livreur non trouvé.');
    if (deliverer.role !== 'LIVREUR') {
      throw new ForbiddenException("L'utilisateur sélectionné n'est pas un livreur.");
    }

    const updated = await this.prisma.delivery.update({
      where: { id: delivery.id },
      data: { delivererId, status: DeliveryStatus.ASSIGNER },
      include: {
        deliverer: { select: { id: true, nom: true, phone: true, imageUrl: true } },
        order: true,
      },
    });

    await this.notificationsService.sendPushNotification(
      deliverer.id,
      'Nouvelle mission',
      `Commande à récupérer chez ${delivery.order.restaurant.nom}`,
      { type: 'delivery_assigned', deliveryId: updated.id, orderId: delivery.orderId },
    );

    return { data: updated, message: 'Livreur assigné avec succès' };
  }

  /**
   * Récupère les livreurs disponibles
   */
  async getAvailableDeliverers() {
    const deliverers = await this.prisma.user.findMany({
      where: {
        role: 'LIVREUR',
      },
      select: {
        id: true,
        nom: true,
        phone: true,
        imageUrl: true,
        _count: {
          select: {
            deliveries: {
              where: {
                status: {
                  in: ['ASSIGNER', 'EN_TRANSIT'],
                },
              },
            },
          },
        },
      },
    });

    return {
      data: deliverers,
      count: deliverers.length,
    };
  }

  async acceptDelivery(deliveryId: string, firebaseUid: string) {
    const user = await this.getUserOrThrow(firebaseUid);
    const delivery = await this.prisma.delivery.findUnique({
      where: { id: deliveryId },
      include: {
        order: { include: { restaurant: { select: { nom: true } } } },
      },
    });

    if (!delivery) throw new NotFoundException('Livraison introuvable.');
    if (delivery.delivererId !== user.id) {
      throw new ForbiddenException('Cette livraison ne vous est pas assignée');
    }
    if (delivery.status !== 'ASSIGNER') {
      throw new BadRequestException('Livraison déjà acceptée ou non assignée');
    }

    // Valide la transition Order PRET → EN_ROUTE via state machine
    this.stateMachine.assertTransition(
      delivery.order.status,
      OrderStatus.EN_ROUTE,
      'LIVREUR',
    );

    const previousOrderStatus = delivery.order.status;
    const now = new Date();

    // Met à jour livraison + statut livreur + commande en transaction
    const [updated] = await this.prisma.$transaction([
      this.prisma.delivery.update({
        where: { id: deliveryId },
        data: { status: 'EN_TRANSIT', pickedUpAt: now },
      }),
      this.prisma.user.update({
        where: { id: user.id },
        data: { driverStatus: 'ON_DELIVERY' },
      }),
      this.prisma.order.update({
        where: { id: delivery.orderId },
        data: { status: OrderStatus.EN_ROUTE },
      }),
    ]);

    // Notifie le client que le livreur est en route — payload structuré
    const statusEvent = new OrderStatusUpdatedEvent(
      delivery.orderId,
      delivery.order.userId,
      delivery.order.restaurantId,
      previousOrderStatus,
      OrderStatus.EN_ROUTE,
      user.id,
      {
        restaurantName: delivery.order.restaurant.nom,
        totalAmount: delivery.order.total,
      },
    );
    this.eventEmitter.emit('order.status.updated', statusEvent);

    return updated;
  }

  async getUserOrThrow(firebaseUid: string) {
    const user = await this.prisma.user.findUnique({
      where: { firebaseUid },
    });

    if (!user) {
      throw new NotFoundException('Utilisateur non trouvé.');
    }
    return user;
  }

  async setDriverStatus(firebaseUid: string, status: DriverStatus) {
    const user = await this.prisma.user.findUnique({ where: { firebaseUid } });
    if (user.role !== 'LIVREUR') throw new ForbiddenException();

    return this.prisma.user.update({
      where: { id: user.id },
      data: { driverStatus: status },
    });
  }

  async getMyAssignedDeliveries(firebaseUid: string) {
    const user = await this.prisma.user.findUnique({ where: { firebaseUid } });
    return this.prisma.delivery.findMany({
      where: {
        delivererId: user.id,
        status: { in: ['ASSIGNER', 'EN_TRANSIT'] },
      },
      include: {
        order: {
          include: {
            user: { select: { nom: true, phone: true } },
            restaurant: { select: { id: true, nom: true, adresse: true, phone: true } },
            items: { include: { product: { select: { nom: true } } } },
          },
        },
      },
    });
  }

  /**
   * Met à jour la position GPS du livreur pour une livraison EN_TRANSIT.
   * Fallback HTTP — préférer le WebSocket /tracking pour réduire le lag.
   * NOTE : ce path écrit directement en DB (pas via TrackingService).
   * Pour ajouter Redis GEO + broadcast WS, utiliser POST /tracking/position.
   */
  async updateLocation(
    deliveryId: string,
    latitude: number,
    longitude: number,
    accuracy: number | undefined,
    firebaseUid: string,
  ) {
    const user = await this.getUserOrThrow(firebaseUid);
    const delivery = await this.prisma.delivery.findUnique({ where: { id: deliveryId } });

    if (!delivery) throw new NotFoundException(`Livraison "${deliveryId}" non trouvée.`);
    if (delivery.delivererId !== user.id) throw new ForbiddenException('Cette livraison ne vous est pas assignée.');
    if (delivery.status !== 'EN_TRANSIT') throw new BadRequestException('La position ne peut être mise à jour que pour une livraison EN_TRANSIT.');

    const now = new Date();

    await this.prisma.$transaction([
      this.prisma.delivery.update({
        where: { id: deliveryId },
        data: { lastLatitude: latitude, lastLongitude: longitude, lastPositionAt: now },
      }),
      this.prisma.deliveryLocation.create({
        data: { deliveryId, latitude, longitude, accuracy, recordedAt: now },
      }),
    ]);

    return { message: 'Position mise à jour', latitude, longitude };
  }

  /**
   * Récupère la livraison associée à une commande (pour le client qui veut tracker)
   */
  async findByOrderId(orderId: string) {
    const delivery = await this.prisma.delivery.findUnique({
      where: { orderId },
      select: {
        id: true,
        status: true,
        lastLatitude: true,
        lastLongitude: true,
        lastPositionAt: true,
        estimatedArrival: true,
        pickedUpAt: true,
        deliveredAt: true,
        createdAt: true,
        deliverer: {
          select: { id: true, nom: true, phone: true, imageUrl: true },
        },
        // Coords de l'adresse client + restaurant pour permettre au client
        // de tracking d'afficher le marker destination et le contexte
        // commande sans appel HTTP additionnel.
        order: {
          select: {
            id: true,
            deliveryLatitude: true,
            deliveryLongitude: true,
            restaurant: {
              select: { id: true, nom: true, latitude: true, longitude: true },
            },
          },
        },
      },
    });

    if (!delivery) throw new NotFoundException('Aucune livraison trouvée pour cette commande.');
    return { data: delivery };
  }
}
