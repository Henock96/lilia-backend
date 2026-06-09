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
import { DeliveryQueryService } from './delivery-query.service';
import { DriverStatus, OrderStatus } from '@prisma/client';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { NotificationsService } from '../notifications/notifications.service';
import { OrderStateMachine } from '../orders/order-state.machine';
import { OrderStatusUpdatedEvent } from '../events/order-events';
import { PlatformSettingsService } from '../platform-settings/platform-settings.service';
import { TrackingGateway } from '../tracking/tracking.gateway';
import { TrackingService } from '../tracking/tracking.service';

type ActorRole = 'CLIENT' | 'RESTAURATEUR' | 'ADMIN' | 'LIVREUR';

// Cycle de vie d'une livraison — transitions autorisées via PATCH /:id/status.
// EN_TRANSIT n'est PAS atteignable ici : il passe par /accept (effets de bord
// sur Order.status + DriverStatus). LIVRER et ECHEC sont des états terminaux.
const DELIVERY_STATUS_TRANSITIONS: Record<string, DeliveryStatus[]> = {
  [DeliveryStatus.EN_ATTENTE]: [DeliveryStatus.ECHEC],
  [DeliveryStatus.ASSIGNER]: [DeliveryStatus.ECHEC],
  [DeliveryStatus.EN_TRANSIT]: [DeliveryStatus.LIVRER, DeliveryStatus.ECHEC],
  [DeliveryStatus.LIVRER]: [],
  [DeliveryStatus.ECHEC]: [],
};

@Injectable()
export class DeliveriesService {
  private readonly logger = new Logger(DeliveriesService.name);

  constructor(
    private prisma: PrismaService,
    private readonly notificationsService: NotificationsService,
    private readonly eventEmitter: EventEmitter2,
    private readonly stateMachine: OrderStateMachine,
    private readonly platformSettings: PlatformSettingsService,
    private readonly trackingGateway: TrackingGateway,
    private readonly trackingService: TrackingService,
    private readonly queryService: DeliveryQueryService,
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
    return this.queryService.findAllForRestaurant(firebaseUid, status, page, limit);
  }

  /**
   * Récupère les livraisons assignées à un livreur
   */
  async findAllForDeliverer(firebaseUid: string, status?: DeliveryStatus) {
    return this.queryService.findAllForDeliverer(firebaseUid, status);
  }

  /**
   * Récupère une livraison par son ID
   */
  async findOne(id: string, firebaseUid: string) {
    return this.queryService.findOne(id, firebaseUid);
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

    // Valide la transition du cycle de vie de la livraison (anti-incohérence) :
    // empêche les sauts arbitraires (LIVRER↔ECHEC, re-livraison d'un état
    // terminal, passage direct à EN_TRANSIT qui doit passer par /accept).
    const allowedNext = DELIVERY_STATUS_TRANSITIONS[delivery.status] ?? [];
    if (!allowedNext.includes(status)) {
      throw new BadRequestException(
        `Transition de livraison invalide : ${delivery.status} → ${status}. ` +
          (status === DeliveryStatus.EN_TRANSIT
            ? 'Utilisez l\'acceptation de mission (/accept) pour démarrer le trajet.'
            : `Transitions possibles : [${allowedNext.join(', ') || 'aucune'}].`),
      );
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

    // Un livreur ne peut être assigné que sur une commande payée et en cours de
    // traitement — pas sur EN_ATTENTE (non payée) ni sur une commande terminée.
    const assignableStatuses: OrderStatus[] = [
      OrderStatus.PAYER,
      OrderStatus.EN_PREPARATION,
      OrderStatus.PRET,
      OrderStatus.EN_ROUTE,
    ];
    if (!assignableStatuses.includes(order.status)) {
      throw new BadRequestException(
        `Impossible d'assigner un livreur à une commande au statut « ${order.status} ».`,
      );
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

    // Note: dépend de Prisma include sur order (cf. assignDeliverer / assignDelivererToOrder)
    // pour que isPreorder/scheduledFor arrivent. Ne pas narrow avec un select sans les ajouter.
    const isPreorder = delivery.order.isPreorder ?? false;
    const scheduledFor = delivery.order.scheduledFor;

    await this.notificationsService.sendPushNotification(
      deliverer.id,
      isPreorder && scheduledFor
        ? '📅 Pré-commande à récupérer le ' + this.formatScheduledForFr(scheduledFor)
        : '🚚 Nouvelle mission',
      `Commande à récupérer chez ${delivery.order.restaurant.nom}`,
      {
        type: 'delivery_assigned',
        deliveryId: updated.id,
        orderId: delivery.orderId,
        isPreorder: String(isPreorder),
        scheduledFor: scheduledFor?.toISOString() ?? '',
      },
    );

    return { data: updated, message: 'Livreur assigné avec succès' };
  }

  /**
   * Récupère les livreurs disponibles
   */
  async getAvailableDeliverers() {
    return this.queryService.getAvailableDeliverers();
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
    // Un livreur déjà en course ne peut pas en accepter une 2e (sinon les
    // positions de tracking des deux commandes seraient confondues).
    // SÉCURITÉ (fix B5) : un livreur ne peut accepter une nouvelle livraison
    // que s'il est AVAILABLE. ON_DELIVERY = course en cours, OFFLINE = pas
    // en service. Sans ce check, un livreur pouvait tenir deux missions
    // simultanées et bloquer le tracking côté client.
    if (user.driverStatus !== DriverStatus.AVAILABLE) {
      throw new BadRequestException(
        user.driverStatus === DriverStatus.ON_DELIVERY
          ? 'Vous avez déjà une livraison en cours. Terminez-la avant d\'en accepter une autre.'
          : 'Vous devez être disponible pour accepter une livraison.',
      );
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
    const user = await this.getUserOrThrow(firebaseUid); // 404 si introuvable (plus de TypeError 500)
    if (user.role !== 'LIVREUR') throw new ForbiddenException();

    return this.prisma.user.update({
      where: { id: user.id },
      data: { driverStatus: status },
    });
  }

  async getMyAssignedDeliveries(firebaseUid: string) {
    return this.queryService.getMyAssignedDeliveries(firebaseUid);
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

    // Convergence avec le path WebSocket (/tracking/position) : on broadcast
    // aussi la position aux clients qui suivent la commande, pour que le fallback
    // HTTP soit équivalent au WS (sinon désync jusqu'au prochain poll 30s — B13).
    // Best-effort : n'échoue jamais la mise à jour de position.
    try {
      const eta = await this.trackingService.calculateETA(
        delivery.orderId,
        latitude,
        longitude,
      );
      this.trackingGateway.server
        ?.to(`order:${delivery.orderId}`)
        ?.emit('driver:position', {
          lat: latitude,
          lng: longitude,
          eta,
          timestamp: now.getTime(),
          source: 'http-delivery',
        });
    } catch (err) {
      this.logger.warn(`Broadcast position fallback échoué: ${(err as Error).message}`);
    }

    return { message: 'Position mise à jour', latitude, longitude };
  }

  /**
   * Récupère la livraison associée à une commande (pour le client qui veut tracker)
   */
  async findByOrderId(orderId: string, firebaseUid: string) {
    return this.queryService.findByOrderId(orderId, firebaseUid);
  }

  private formatScheduledForFr(d: Date): string {
    // scheduledFor est stocké en UTC. Le serveur Render tourne en UTC.
    // Brazzaville = WAT = UTC+1. On décale explicitement puis on lit
    // les composantes UTC pour avoir l'heure locale Congo.
    const wat = new Date(d.getTime() + 60 * 60 * 1000);
    const days = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
    const months = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin',
                    'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
    const dayName = days[wat.getUTCDay()].charAt(0).toUpperCase() + days[wat.getUTCDay()].slice(1);
    const hh = wat.getUTCHours().toString().padStart(2, '0');
    const mm = wat.getUTCMinutes().toString().padStart(2, '0');
    return `${dayName} ${wat.getUTCDate()} ${months[wat.getUTCMonth()]} à ${hh}:${mm}`;
  }
}
