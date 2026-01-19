import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { DeliveryStatus } from './dto/update-delivery.dto';

@Injectable()
export class DeliveriesService {
  constructor(private prisma: PrismaService) {}

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
   * Assigne un livreur à une livraison
   */
  async assignDeliverer(id: string, delivererId: string, firebaseUid: string) {
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
      },
    });

    if (!delivery) {
      throw new NotFoundException(`Livraison avec l'ID "${id}" non trouvée.`);
    }

    // Vérifier que l'utilisateur est le propriétaire du restaurant ou admin
    const user = await this.prisma.user.findUnique({
      where: { firebaseUid },
    });

    if (!user) {
      throw new NotFoundException('Utilisateur non trouvé.');
    }

    const isRestaurantOwner = delivery.order.restaurant.owner.firebaseUid === firebaseUid;
    const isAdmin = user.role === 'ADMIN';

    if (!isRestaurantOwner && !isAdmin) {
      throw new ForbiddenException('Vous n\'êtes pas autorisé à assigner un livreur à cette livraison.');
    }

    // Vérifier que le livreur existe et a le rôle LIVREUR
    const deliverer = await this.prisma.user.findUnique({
      where: { id: delivererId },
    });

    if (!deliverer) {
      throw new NotFoundException('Livreur non trouvé.');
    }

    if (deliverer.role !== 'LIVREUR') {
      throw new ForbiddenException('L\'utilisateur sélectionné n\'est pas un livreur.');
    }

    const updated = await this.prisma.delivery.update({
      where: { id },
      data: {
        delivererId,
        status: DeliveryStatus.ASSIGNER,
      },
      include: {
        deliverer: {
          select: {
            id: true,
            nom: true,
            phone: true,
            imageUrl: true,
          },
        },
        order: true,
      },
    });

    return {
      data: updated,
      message: 'Livreur assigné avec succès',
    };
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
}
