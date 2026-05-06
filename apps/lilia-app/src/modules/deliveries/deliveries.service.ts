/* eslint-disable prettier/prettier */
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { DeliveryStatus } from './dto/update-delivery.dto';
import { DriverStatus, OrderStatus } from '@prisma/client';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { NotificationsService } from '../notifications/notifications.service';

@Injectable()
export class DeliveriesService {
  constructor(private prisma: PrismaService,
    private readonly notificationsService: NotificationsService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

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
   * Met à jour le statut d'une livraison
   */
  async updateStatus(id: string, status: DeliveryStatus, firebaseUid: string) {
    const delivery = await this.prisma.delivery.findUnique({
      where: { id },
      include: {
        order: {
          include: {
            restaurant: {
              include: { owner: true },
            },
          },
        },
        deliverer: true,
      },
    });

    if (!delivery) {
      throw new NotFoundException(`Livraison avec l'ID "${id}" non trouvée.`);
    }

    const user = await this.prisma.user.findUnique({
      where: { firebaseUid },
    });

    if (!user) {
      throw new NotFoundException('Utilisateur non trouvé.');
    }

    // Vérifier les permissions: le propriétaire du restaurant ou le livreur assigné peut modifier le statut
    const isRestaurantOwner = delivery.order.restaurant.owner.firebaseUid === firebaseUid;
    const isAssignedDeliverer = delivery.delivererId === user.id;
    const isAdmin = user.role === 'ADMIN';

    if (!isRestaurantOwner && !isAssignedDeliverer && !isAdmin) {
      throw new ForbiddenException('Vous n\'êtes pas autorisé à modifier cette livraison.');
    }

    const updated = await this.prisma.delivery.update({
      where: { id },
      data: { status },
      include: {
        order: true,
        deliverer: {
          select: {
            id: true,
            nom: true,
            phone: true,
          },
        },
      },
    });

    // Si la livraison est marquée comme livrée, mettre à jour le statut de la commande
    if (status === DeliveryStatus.LIVRER) {
      await this.prisma.order.update({
        where: { id: delivery.orderId },
        data: { status: 'LIVRER' },
      });
    }

    return {
      data: updated,
      message: 'Statut de livraison mis à jour',
    };
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
      include: { order: true },
    });

    if (delivery.delivererId !== user.id) {
      throw new ForbiddenException('Cette livraison ne vous est pas assignée');
    }
    if (delivery.status !== 'ASSIGNER') {
      throw new BadRequestException('Livraison déjà acceptée ou non assignée');
    }

    // Met à jour livraison + statut livreur en transaction
    const [updated] = await this.prisma.$transaction([
      this.prisma.delivery.update({
        where: { id: deliveryId },
        data: { status: 'EN_TRANSIT' },
      }),
      this.prisma.user.update({
        where: { id: user.id },
        data: { driverStatus: 'ON_DELIVERY' },
      }),
      // Passe la commande en EN_LIVRAISON via state machine
      this.prisma.order.update({
        where: { id: delivery.orderId },
        data: { status: OrderStatus.EN_ROUTE },
      }),
    ]);

    // Notifie le client que le livreur est en route
    this.eventEmitter.emit('order.status.updated', {
      orderId: delivery.orderId,
      newStatus: OrderStatus.EN_ROUTE,
      ...delivery.order,
    });

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
   * Met à jour la position GPS du livreur pour une livraison EN_TRANSIT
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
        deliverer: {
          select: { id: true, nom: true, phone: true, imageUrl: true },
        },
      },
    });

    if (!delivery) throw new NotFoundException('Aucune livraison trouvée pour cette commande.');
    return { data: delivery };
  }
}
