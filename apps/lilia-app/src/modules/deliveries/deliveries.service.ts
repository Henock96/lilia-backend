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
import { DeliveryAssignmentService } from './delivery-assignment.service';
import { DriverStatus, OrderStatus } from '@prisma/client';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { NotificationsService } from '../notifications/notifications.service';
import { OrderStateMachine } from '../orders/order-state.machine';
import { OrderStatusUpdatedEvent } from '../events/order-events';
import { DeliveryFailedEvent } from '../events/delivery-events';
import { TrackingGateway } from '../tracking/tracking.gateway';
import { TrackingService } from '../tracking/tracking.service';
import { LoyaltyService } from '../loyalty/loyalty.service';

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
    private readonly trackingGateway: TrackingGateway,
    private readonly trackingService: TrackingService,
    private readonly queryService: DeliveryQueryService,
    private readonly assignmentService: DeliveryAssignmentService,
    private readonly loyalty: LoyaltyService,
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
   * Récupère toutes les livraisons pour un restaurant
   */
  async findAllForRestaurant(firebaseUid: string, status?: DeliveryStatus, page = 1, limit = 20) {
    return this.queryService.findAllForRestaurant(firebaseUid, status, page, limit);
  }

  /**
   * Récupère les livraisons assignées à un livreur
   */
  async findAllForDeliverer(
    firebaseUid: string,
    status?: DeliveryStatus,
    page?: number,
    limit?: number,
  ) {
    return this.queryService.findAllForDeliverer(
      firebaseUid,
      status,
      page,
      limit,
    );
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
  async updateStatus(
    id: string,
    status: DeliveryStatus,
    firebaseUid: string,
    reason?: string,
  ) {
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

    // Update atomique : Delivery + Order + DriverStatus.
    //
    // Fix L13 : `ECHEC` faisait DEUX `delivery.update` sur la même ligne dans
    // la même transaction (le statut, puis le détachement du livreur). Les deux
    // écritures sont fusionnées ci-dessous.
    //
    // ECHEC : la commande n'est PAS annulée automatiquement — c'est le vendeur
    // qui arbitre entre réassigner un livreur et annuler. On retire simplement
    // le livreur de la livraison pour qu'elle redevienne assignable ; le statut
    // de la commande reste inchangé jusqu'à sa décision.
    const operations: any[] = [
      this.prisma.delivery.update({
        where: { id },
        data: {
          status,
          ...(status === DeliveryStatus.LIVRER ? { deliveredAt: now } : {}),
          ...(status === DeliveryStatus.ECHEC && delivery.delivererId
            ? { delivererId: null }
            : {}),
        },
      }),
    ];

    if (status === DeliveryStatus.LIVRER) {
      operations.push(
        // Verrou optimiste (fix H6) : on n'écrase pas une commande que
        // quelqu'un d'autre a fait avancer entre la lecture et l'écriture.
        this.prisma.order.updateMany({
          where: { id: delivery.orderId, status: previousOrderStatus },
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
      // Implémentation unique et idempotente (fix M5) : l'autre chemin vers
      // LIVRER (PATCH /orders/:id/status) appelle exactement le même service.
      this.loyalty
        .awardForDeliveredOrder(
          delivery.order.userId,
          delivery.orderId,
          delivery.order.subTotal,
        )
        .catch((err) => this.logger.error(`Erreur points fidélité: ${err}`));
    }

    // ECHEC était un cul-de-sac silencieux : aucun event, aucune notification,
    // et le statut de la commande jamais touché — le client restait sur
    // « votre livreur est en chemin » indéfiniment et le vendeur n'apprenait
    // rien. `DeliveriesListener` prévient les trois parties et trace un
    // incident pour qu'une commande oubliée reste visible en supervision.
    if (status === DeliveryStatus.ECHEC) {
      this.eventEmitter.emit(
        'delivery.failed',
        new DeliveryFailedEvent(
          delivery.id,
          delivery.orderId,
          delivery.order.restaurantId,
          delivery.order.userId,
          delivery.delivererId ?? null,
          delivery.order.restaurant.nom,
          reason ?? null,
          user.id,
        ),
      );
    }

    return { data: updated, message: 'Statut de livraison mis à jour' };
  }

  /**
   * Assigne un livreur via l'ID de livraison (doit déjà exister)
   */
  async assignDeliverer(id: string, delivererId: string, firebaseUid: string) {
    return this.assignmentService.assignDeliverer(id, delivererId, firebaseUid);
  }

  /**
   * Assigne un livreur via l'ID de commande (crée la livraison si elle n'existe pas)
   */
  async assignDelivererToOrder(orderId: string, delivererId: string, firebaseUid: string) {
    return this.assignmentService.assignDelivererToOrder(orderId, delivererId, firebaseUid);
  }

  /**
   * Récupère les livreurs disponibles
   */
  async getAvailableDeliverers() {
    return this.queryService.getAvailableDeliverers();
  }

  async acceptDelivery(deliveryId: string, firebaseUid: string) {
    return this.assignmentService.acceptDelivery(deliveryId, firebaseUid);
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

  /**
   * Le livreur change son statut de disponibilité.
   *
   * Fix M4 (audit du 28/08/2026) : la méthode n'avait AUCUNE garde. Le contrôle
   * de `acceptDelivery` (qui exige `AVAILABLE`) devenait donc contournable —
   * accepter la course A, se remettre `AVAILABLE`, accepter la course B. Deux
   * livraisons `EN_TRANSIT` simultanées, alors qu'il n'existe **qu'une seule**
   * clé GEO `driver_positions` par livreur : les deux clients voyaient la même
   * position, et l'un des deux suivait une course qui n'était pas la sienne.
   */
  async setDriverStatus(firebaseUid: string, status: DriverStatus) {
    const user = await this.getUserOrThrow(firebaseUid); // 404 si introuvable (plus de TypeError 500)
    if (user.role !== 'LIVREUR') throw new ForbiddenException();

    if (status === DriverStatus.AVAILABLE || status === DriverStatus.OFFLINE) {
      const activeDelivery = await this.prisma.delivery.findFirst({
        where: {
          delivererId: user.id,
          status: { in: ['ASSIGNER', 'EN_TRANSIT'] },
        },
        select: { id: true, orderId: true, status: true },
      });

      if (activeDelivery) {
        throw new BadRequestException(
          `Vous avez une livraison en cours (${activeDelivery.status}). ` +
            'Terminez-la ou signalez un échec avant de changer votre statut.',
        );
      }
    }

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

    // Convergence avec le path WebSocket (/tracking/position) : on alimente le
    // cache Redis live (source de vérité temps réel) ET on broadcast la position
    // aux clients qui suivent la commande, pour que le fallback HTTP soit
    // équivalent au WS (sinon désync : un (re)watch lirait une position périmée,
    // et le client attendrait le prochain poll 30s — B13 / LIL-54).
    // Best-effort : n'échoue jamais la mise à jour de position.
    try {
      // Source de vérité temps réel : GEO + métadonnées TTL (no-op si Redis off).
      await this.trackingService.cacheLivePosition({
        orderId: delivery.orderId,
        driverId: user.id,
        lat: latitude,
        lng: longitude,
        accuracy,
      });

      const eta = await this.trackingService.calculateETA(
        delivery.orderId,
        latitude,
        longitude,
      );
      this.trackingGateway.broadcastDriverPosition(delivery.orderId, {
        lat: latitude,
        lng: longitude,
        eta,
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

}
