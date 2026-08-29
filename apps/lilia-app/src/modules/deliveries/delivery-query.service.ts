import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { DeliveryStatus } from './dto/update-delivery.dto';

/**
 * Lectures de livraisons (queries) extraites de `DeliveriesService` (LIL-134).
 *
 * Responsabilité unique : récupérer/paginer des livraisons avec contrôle de
 * propriété anti-IDOR. Aucune mutation, aucun event. `DeliveriesService` y
 * délègue — API publique inchangée.
 */
@Injectable()
export class DeliveryQueryService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Contrôle de propriété pour la consultation d'une livraison (anti-IDOR).
   * Autorisé : ADMIN, le restaurateur propriétaire du resto, le client
   * propriétaire de la commande, ou le livreur assigné. Sinon ForbiddenException.
   */
  private async assertCanViewDelivery(ctx: {
    orderUserId: string;
    ownerFirebaseUid: string | null;
    delivererId: string | null;
    requesterFirebaseUid: string;
  }): Promise<void> {
    // Restaurateur propriétaire du restaurant
    if (
      ctx.ownerFirebaseUid &&
      ctx.ownerFirebaseUid === ctx.requesterFirebaseUid
    ) {
      return;
    }

    const user = await this.prisma.user.findUnique({
      where: { firebaseUid: ctx.requesterFirebaseUid },
      select: { id: true, role: true },
    });
    if (!user) throw new NotFoundException('Utilisateur non trouvé.');

    if (user.role === 'ADMIN') return;
    if (user.id === ctx.orderUserId) return; // client propriétaire de la commande
    if (ctx.delivererId && user.id === ctx.delivererId) return; // livreur assigné

    throw new ForbiddenException(
      "Vous n'êtes pas autorisé à consulter cette livraison.",
    );
  }

  /**
   * Récupère toutes les livraisons pour un restaurant
   */
  async findAllForRestaurant(
    firebaseUid: string,
    status?: DeliveryStatus,
    page = 1,
    limit = 20,
  ) {
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
                  product: { select: { nom: true, imageUrl: true } },
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
  /**
   * Historique du livreur — **paginé** (fix P1, audit du 28/08/2026).
   *
   * La méthode ramenait l'intégralité des courses du livreur, avec pour
   * chacune la commande, ses items et les produits. Sur un livreur actif
   * depuis six mois, la réponse ne cesse de grossir — et elle est chargée à
   * l'ouverture de l'app, sur la 4G de Brazzaville.
   */
  async findAllForDeliverer(
    firebaseUid: string,
    status?: DeliveryStatus,
    page = 1,
    limit = 20,
  ) {
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
                vendorType: true,
                acceptsPreorders: true,
                preorderLeadHours: true,
              },
            },
            items: {
              include: {
                product: { select: { nom: true, imageUrl: true } },
              },
            },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    });

    const total = await this.prisma.delivery.count({ where });

    return {
      data: deliveries,
      count: deliveries.length,
      meta: { page, limit, total, hasMore: page * limit < total },
    };
  }

  /**
   * Récupère une livraison par son ID
   */
  async findOne(id: string, firebaseUid: string) {
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
                vendorType: true,
                acceptsPreorders: true,
                preorderLeadHours: true,
                owner: { select: { firebaseUid: true } },
              },
            },
            items: {
              include: {
                product: { select: { nom: true, imageUrl: true } },
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

    // Anti-IDOR : seuls les acteurs liés à cette livraison peuvent la consulter
    await this.assertCanViewDelivery({
      orderUserId: delivery.order.userId,
      ownerFirebaseUid: delivery.order.restaurant.owner?.firebaseUid ?? null,
      delivererId: delivery.delivererId,
      requesterFirebaseUid: firebaseUid,
    });

    // On retire le firebaseUid du propriétaire avant de répondre (champ interne)
    const { owner: _owner, ...restaurant } = delivery.order.restaurant;
    return {
      data: {
        ...delivery,
        order: { ...delivery.order, restaurant },
      },
    };
  }

  /**
   * Livreurs assignables, pour le vendeur qui doit choisir à qui confier une
   * course.
   *
   * Fix L11 : la méthode retournait **tous** les comptes LIVREUR de la
   * plateforme — nom et téléphone inclus — sans le moindre filtre de
   * disponibilité, à tout titulaire d'un compte vendeur. On exclut désormais
   * les comptes hors ligne, bloqués ou supprimés : un vendeur n'a besoin que
   * des livreurs à qui il peut réellement confier une course.
   */
  async getAvailableDeliverers() {
    const deliverers = await this.prisma.user.findMany({
      where: {
        role: 'LIVREUR',
        statusUser: 'ACTIVE',
        // `driverStatus` est nullable : un livreur qui ne s'est jamais déclaré
        // reste assignable (comportement historique), seul OFFLINE est exclu.
        OR: [
          { driverStatus: { in: ['AVAILABLE', 'ON_DELIVERY'] } },
          { driverStatus: null },
        ],
      },
      select: {
        id: true,
        nom: true,
        phone: true,
        imageUrl: true,
        driverStatus: true,
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
            restaurant: {
              select: {
                id: true,
                nom: true,
                adresse: true,
                phone: true,
                vendorType: true,
                acceptsPreorders: true,
                preorderLeadHours: true,
              },
            },
            items: {
              include: {
                product: { select: { nom: true, madeToOrder: true } },
              },
            },
          },
        },
      },
    });
  }

  /**
   * Récupère la livraison associée à une commande (pour le client qui veut tracker)
   */
  async findByOrderId(orderId: string, firebaseUid: string) {
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
        // Champs internes utilisés uniquement pour le contrôle d'accès (retirés
        // de la réponse plus bas).
        delivererId: true,
        deliverer: {
          select: { id: true, nom: true, phone: true, imageUrl: true },
        },
        // Coords de l'adresse client + restaurant pour permettre au client
        // de tracking d'afficher le marker destination et le contexte
        // commande sans appel HTTP additionnel.
        order: {
          select: {
            id: true,
            userId: true,
            deliveryLatitude: true,
            deliveryLongitude: true,
            restaurant: {
              select: {
                id: true,
                nom: true,
                latitude: true,
                longitude: true,
                owner: { select: { firebaseUid: true } },
              },
            },
          },
        },
      },
    });

    if (!delivery)
      throw new NotFoundException(
        'Aucune livraison trouvée pour cette commande.',
      );

    // Anti-IDOR : la position GPS du livreur et les coordonnées du client ne
    // doivent être visibles que par les parties liées à la commande.
    await this.assertCanViewDelivery({
      orderUserId: delivery.order.userId,
      ownerFirebaseUid: delivery.order.restaurant.owner?.firebaseUid ?? null,
      delivererId: delivery.delivererId,
      requesterFirebaseUid: firebaseUid,
    });

    // Retire les champs internes (delivererId, userId, owner.firebaseUid)
    const { delivererId: _delivererId, order, ...rest } = delivery;
    const { userId: _userId, restaurant, ...orderRest } = order;
    const { owner: _owner, ...publicRestaurant } = restaurant;

    return {
      data: {
        ...rest,
        order: { ...orderRest, restaurant: publicRestaurant },
      },
    };
  }
}
