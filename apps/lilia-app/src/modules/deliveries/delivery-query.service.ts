import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { DeliveryStatus } from './dto/update-delivery.dto';
import { ACTIVE_DELIVERY_STATUSES } from './delivery-statuses';
import { DeliveryAssignmentLogService } from './delivery-assignment-log.service';

/**
 * Lectures de livraisons (queries) extraites de `DeliveriesService` (LIL-134).
 *
 * Responsabilité unique : récupérer/paginer des livraisons avec contrôle de
 * propriété anti-IDOR. Aucune mutation, aucun event. `DeliveriesService` y
 * délègue — API publique inchangée.
 */
@Injectable()
export class DeliveryQueryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly assignmentLog: DeliveryAssignmentLogService,
  ) {}

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
  }): Promise<'VENDOR' | 'ADMIN' | 'CLIENT' | 'DRIVER'> {
    // Restaurateur propriétaire du restaurant
    if (
      ctx.ownerFirebaseUid &&
      ctx.ownerFirebaseUid === ctx.requesterFirebaseUid
    ) {
      return 'VENDOR';
    }

    const user = await this.prisma.user.findUnique({
      where: { firebaseUid: ctx.requesterFirebaseUid },
      select: { id: true, role: true },
    });
    if (!user) throw new NotFoundException('Utilisateur non trouvé.');

    if (user.role === 'ADMIN') return 'ADMIN';
    if (user.id === ctx.orderUserId) return 'CLIENT'; // client propriétaire de la commande
    if (ctx.delivererId && user.id === ctx.delivererId) return 'DRIVER'; // livreur assigné

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
   * Toutes les mains par lesquelles une course est passée.
   *
   * Réservé à l'ADMIN et au vendeur propriétaire — **pas au livreur**. Il est
   * légitime qu'il voie sa propre mission ; savoir à qui elle a été retirée
   * avant lui, ou à qui elle est passée après, ne le regarde pas et nourrirait
   * une conversation qu'on n'a aucune raison d'ouvrir.
   *
   * Le client non plus : il lui suffit de savoir qui livre **maintenant**
   * (`GET /deliveries/by-order/:orderId`), et l'historique des désistements
   * n'apprendrait rien d'utile à quelqu'un qui attend son repas.
   */
  async findAssignmentHistory(deliveryId: string, firebaseUid: string) {
    const delivery = await this.prisma.delivery.findUnique({
      where: { id: deliveryId },
      select: {
        id: true,
        orderId: true,
        order: {
          select: {
            restaurant: {
              select: { owner: { select: { firebaseUid: true } } },
            },
          },
        },
      },
    });

    if (!delivery) {
      throw new NotFoundException(
        `Livraison avec l'ID "${deliveryId}" non trouvée.`,
      );
    }

    const estProprietaire =
      delivery.order.restaurant.owner?.firebaseUid === firebaseUid;

    if (!estProprietaire) {
      const user = await this.prisma.user.findUnique({
        where: { firebaseUid },
        select: { role: true },
      });
      if (user?.role !== 'ADMIN') {
        throw new ForbiddenException(
          "Vous n'êtes pas autorisé à consulter l'historique de cette livraison.",
        );
      }
    }

    const assignments = await this.assignmentLog.history(
      this.prisma,
      deliveryId,
    );

    return {
      data: assignments,
      meta: {
        deliveryId: delivery.id,
        orderId: delivery.orderId,
        /// Combien de fois la course a changé de mains. La question du §6-C,
        /// qui n'avait aucune réponse avant le journal.
        handoverCount: Math.max(0, assignments.length - 1),
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
                // Coordonnees du point de retrait : le livreur doit pouvoir lancer
                // un itineraire vers le comptoir, pas seulement vers le client.
                latitude: true,
                longitude: true,
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
                // Coordonnees du point de retrait : le livreur doit pouvoir lancer
                // un itineraire vers le comptoir, pas seulement vers le client.
                latitude: true,
                longitude: true,
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
        // Le profil métier doit exister ET être en service. Cette condition
        // reprend mot pour mot celle de `assertAssignable` côté écriture : les
        // deux doivent dire la même chose, sinon la liste propose des livreurs
        // que l'assignation refuse ensuite — ou l'inverse, ce qui est pire.
        driverProfile: { isActive: true },
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
              where: { status: { in: ACTIVE_DELIVERY_STATUSES } },
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
    // `user.id` sur `null` levait un TypeError, donc un 500 : une panne serveur
    // là où le cas est parfaitement connu. Les deux autres lectures de ce
    // fichier posaient déjà ce contrôle.
    if (!user) throw new NotFoundException('Utilisateur non trouvé.');

    return this.prisma.delivery.findMany({
      where: {
        delivererId: user.id,
        // `ACCEPTER` y figure : c'est l'état d'une course prise en charge dont
        // le repas n'est pas encore récupéré. L'omettre ferait disparaître la
        // mission de l'écran du livreur entre le moment où il accepte et celui
        // où il arrive au restaurant.
        status: { in: ACTIVE_DELIVERY_STATUSES },
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
                // Coordonnees du point de retrait : le livreur doit pouvoir lancer
                // un itineraire vers le comptoir, pas seulement vers le client.
                latitude: true,
                longitude: true,
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
        acceptedAt: true,
        delivererId: true,
        deliverer: {
          select: { id: true, nom: true, phone: true, imageUrl: true },
        },
        // La note déjà laissée : permet au client de savoir s'il peut encore
        // noter, sans un second appel réseau.
        review: { select: { id: true, rating: true, createdAt: true } },
        // Coords de l'adresse client + restaurant pour permettre au client
        // de tracking d'afficher le marker destination et le contexte
        // commande sans appel HTTP additionnel.
        order: {
          select: {
            id: true,
            userId: true,
            deliveryLatitude: true,
            deliveryLongitude: true,
            // La précision voyage avec les coordonnées, sans exception : une
            // position sans sa fiabilité serait affichée avec le même aplomb
            // qu'un point posé à la main, et c'est précisément ce qu'on
            // cherche à ne plus faire.
            deliveryPrecision: true,
            deliveryAddress: true,
            deliveryLandmark: true,
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
    const viewer = await this.assertCanViewDelivery({
      orderUserId: delivery.order.userId,
      ownerFirebaseUid: delivery.order.restaurant.owner?.firebaseUid ?? null,
      delivererId: delivery.delivererId,
      requesterFirebaseUid: firebaseUid,
    });

    // Fix F-06 — le code de remise n'est lu que pour le CLIENT, et seulement
    // tant que son repas roule vers lui. Ni le livreur (c'est à lui qu'on le
    // dicte), ni le vendeur, ni un autre champ de cette réponse ne le portent.
    const handoverCode =
      viewer === 'CLIENT' && delivery.status === 'EN_TRANSIT'
        ? ((
            await this.prisma.deliveryHandover.findUnique({
              where: { deliveryId: delivery.id },
              select: { code: true },
            })
          )?.code ?? null)
        : null;

    // Retire les champs internes (delivererId, userId, owner.firebaseUid)
    const { delivererId: _delivererId, order, ...rest } = delivery;
    const { userId: _userId, restaurant, ...orderRest } = order;
    const { owner: _owner, ...publicRestaurant } = restaurant;

    return {
      data: {
        ...rest,
        handoverCode,
        order: { ...orderRest, restaurant: publicRestaurant },
      },
    };
  }
}
