/* eslint-disable prettier/prettier */
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { OutboxService } from '../outbox/outbox.service';
import { AdminAuditService } from '../admin-audit/admin-audit.service';
import { ConfigService } from '@nestjs/config';
import {
  HANDOVER_MAX_ATTEMPTS,
  handoverCodeMatches,
} from './delivery-handover';
import { ORDER_DELIVERED_EVENT } from '../outbox/outbox-events';
import { PrismaService } from '../../prisma/prisma.service';
import { CLEARED_DRIVER_ECONOMICS } from './delivery-assignment.service';
import { DeliveryStatus } from './dto/update-delivery.dto';
import { DeliveryQueryService } from './delivery-query.service';
import { ACTIVE_DELIVERY_STATUSES } from './delivery-statuses';
import { DeliveryAssignmentService } from './delivery-assignment.service';
import {
  AdminAuditAction,
  DeliveryAssignmentOutcome,
  DeliveryHandoverMethod,
  DriverStatus,
  OrderStatus,
} from '@prisma/client';
import { DeliveryAssignmentLogService } from './delivery-assignment-log.service';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { NotificationsService } from '../notifications/notifications.service';
import { OrderStateMachine } from '../orders/order-state.machine';
import { OrderTransitionService } from '../orders/order-transition.service';
import { sourceFromRole } from '../orders/order-transition.types';
import { OrderStatusUpdatedEvent } from '../events/order-events';
import { DeliveryFailedEvent } from '../events/delivery-events';
import { TrackingGateway } from '../tracking/tracking.gateway';
import { TrackingService } from '../tracking/tracking.service';
import { LoyaltyService } from '../loyalty/loyalty.service';
import { ReferralService } from '../users/referral.service';

type ActorRole = 'CLIENT' | 'RESTAURATEUR' | 'ADMIN' | 'LIVREUR';

// Cycle de vie d'une livraison — transitions autorisées via PATCH /:id/status.
//
// Deux transitions ne passent PAS par ici, car elles ont des effets de bord sur
// `Order.status` et `DriverStatus` et méritent chacune leur endpoint explicite :
//   ASSIGNER → ACCEPTER    : PATCH /:id/accept
//   ACCEPTER → EN_TRANSIT  : PATCH /:id/pickup
//
// Conséquence directe : `LIVRER` n'est atteignable que depuis `EN_TRANSIT`,
// donc une commande ne peut pas être déclarée livrée sans avoir été récupérée.
// LIVRER et ECHEC sont terminaux.
const DELIVERY_STATUS_TRANSITIONS: Record<string, DeliveryStatus[]> = {
  [DeliveryStatus.EN_ATTENTE]: [DeliveryStatus.ECHEC],
  [DeliveryStatus.ASSIGNER]: [DeliveryStatus.ECHEC],
  // Le livreur a accepté mais n'a pas (ou plus) la commande : il peut encore
  // renoncer, par exemple s'il n'arrive pas à joindre le restaurant.
  [DeliveryStatus.ACCEPTER]: [DeliveryStatus.ECHEC],
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
    private readonly transitions: OrderTransitionService,
    private readonly trackingGateway: TrackingGateway,
    private readonly trackingService: TrackingService,
    private readonly queryService: DeliveryQueryService,
    private readonly assignmentService: DeliveryAssignmentService,
    private readonly loyalty: LoyaltyService,
    private readonly referral: ReferralService,
    private readonly assignmentLog: DeliveryAssignmentLogService,
    private readonly outbox: OutboxService,
    private readonly audit: AdminAuditService,
    // Optionnel : absent (tests, outils), le code n'est pas EXIGÉ — il reste
    // vérifié dès qu'il est fourni.
    @Optional() private readonly config?: ConfigService,
  ) {}

  /**
   * Atteste la remise d'une course au client (F-06). Rend la méthode retenue
   * ou lève — sans rien écrire sur la course elle-même.
   *
   *  - ADMIN : arbitrage, sans code, tracé au journal d'audit par l'appelant.
   *  - LIVREUR, course avec code : chaque saisie consomme un essai AVANT la
   *    comparaison (`HANDOVER_MAX_ATTEMPTS`), la bonne comprise ; au-delà, seul
   *    un ADMIN peut conclure.
   *  - LIVREUR, course sans code (récupérée avant la mise en service) :
   *    `UNVERIFIED`. Idem si le code n'est pas fourni alors que
   *    `DELIVERY_HANDOVER_CODE_REQUIRED` est faux — période de transition, le
   *    temps que les applications livreur installées soient mises à jour.
   */
  private async attestHandover(
    deliveryId: string,
    user: { id: string; role: string },
    providedCode?: string,
  ): Promise<{ method: DeliveryHandoverMethod }> {
    if (user.role === 'ADMIN') {
      return { method: DeliveryHandoverMethod.ADMIN_OVERRIDE };
    }

    const record = await this.prisma.deliveryHandover.findUnique({
      where: { deliveryId },
      select: { code: true },
    });
    if (!record) return { method: DeliveryHandoverMethod.UNVERIFIED };

    const code = providedCode?.trim();
    if (!code) {
      if (this.handoverCodeRequired()) {
        throw new BadRequestException({
          message:
            'Demandez au client son code de remise (4 chiffres, affiché dans son application) pour confirmer la livraison.',
          code: 'HANDOVER_CODE_REQUIRED',
        });
      }
      return { method: DeliveryHandoverMethod.UNVERIFIED };
    }

    // Un essai consommé, atomiquement, AVANT de comparer.
    const consumed = await this.prisma.deliveryHandover.updateMany({
      where: { deliveryId, attempts: { lt: HANDOVER_MAX_ATTEMPTS } },
      data: { attempts: { increment: 1 } },
    });
    if (consumed.count === 0) {
      throw new ForbiddenException({
        message:
          'Trop de codes erronés : la livraison doit être confirmée par le support Lilia Food.',
        code: 'HANDOVER_CODE_LOCKED',
      });
    }

    if (!handoverCodeMatches(record.code, code)) {
      const { attempts } = await this.prisma.deliveryHandover.findUniqueOrThrow({
        where: { deliveryId },
        select: { attempts: true },
      });
      const left = Math.max(0, HANDOVER_MAX_ATTEMPTS - attempts);
      throw new BadRequestException({
        message:
          left > 0
            ? `Code de remise incorrect. ${left} essai${left > 1 ? 's' : ''} restant${left > 1 ? 's' : ''}.`
            : 'Code de remise incorrect. Plus aucun essai : contactez le support Lilia Food.',
        code: 'HANDOVER_CODE_INVALID',
      });
    }
    return { method: DeliveryHandoverMethod.CODE };
  }

  private handoverCodeRequired(): boolean {
    const raw = this.config?.get<string | boolean>(
      'DELIVERY_HANDOVER_CODE_REQUIRED',
    );
    return raw === true || raw === 'true';
  }

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
   * Toutes les mains par lesquelles une course est passée (ADMIN / vendeur).
   */
  async findAssignmentHistory(id: string, firebaseUid: string) {
    return this.queryService.findAssignmentHistory(id, firebaseUid);
  }

  /**
   * Met à jour le statut d'une livraison.
   *
   * Quand status = LIVRER :
   *  - Vérifie la transition Order EN_ROUTE → LIVRER via state machine
   *  - Met à jour Order.status, Delivery.deliveredAt, User.driverStatus = AVAILABLE
   *  - Émet `order.status.updated` → FCM client + broadcast WebSocket
   *  - Crédite le forfait de fidélité et arbitre la récompense de parrainage
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
    handoverCode?: string,
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

    // F3-05 (défaut P3) — une fois le repas parti avec le livreur, le vendeur
    // ne sait pas ce qui s'est passé : il ne peut plus déclarer l'échec.
    if (
      status === DeliveryStatus.ECHEC &&
      delivery.status === DeliveryStatus.EN_TRANSIT &&
      !isAdmin &&
      !isAssignedDeliverer
    ) {
      throw new ForbiddenException(
        'Le repas est parti avec le livreur : seul lui ou l’administration peut déclarer l’échec.',
      );
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
    const actorRole = this.resolveActor(user.role);
    if (status === DeliveryStatus.LIVRER) {
      if (!actorRole)
        throw new ForbiddenException('Acteur invalide pour cette transition.');
      this.stateMachine.assertTransition(
        delivery.order.status,
        OrderStatus.LIVRER,
        actorRole,
      );
    }

    const now = new Date();
    const previousOrderStatus = delivery.order.status;

    // Fix F-06 — « Livré » exige la preuve que le client a reçu sa commande.
    const handover =
      status === DeliveryStatus.LIVRER
        ? await this.attestHandover(id, user, handoverCode)
        : null;

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
    //
    // ─── Correction S8 (P0-4) ─────────────────────────────────────────────
    //
    // Ce bloc était un `$transaction([...])` — un tableau d'opérations dont le
    // résultat n'était **jamais lu**. Le verrou optimiste sur la commande était
    // donc posé et son `count` jeté. Quand la commande bougeait entre la lecture
    // et l'écriture (annulation ADMIN concurrente, par exemple) :
    //
    //   · `Delivery` passait `LIVRER` et recevait son `deliveredAt` ;
    //   · `Order` ne bougeait pas — 0 ligne affectée, en silence ;
    //   · l'événement `order.status.updated` partait quand même avec
    //     `toStatus = LIVRER`, donc le client recevait « 🎉 Commande livrée »
    //     sur une commande annulée ;
    //   · les points de fidélité et la récompense de parrainage étaient
    //     crédités sur cette même commande.
    //
    // Le contrôle vit maintenant **dans** la transaction : si la commande n'a
    // pas bougé, tout est annulé, y compris la livraison — et les effets de bord
    // (événements, fidélité, parrainage) ne sont déclenchés qu'après le succès.
    await this.prisma.$transaction(async (tx) => {
      // Verrou optimiste sur la LIVRAISON, qu'elle n'avait pas : l'écriture
      // était un `update` inconditionnel. Un double-tap du livreur passait deux
      // fois. `confirmPickup` posait déjà cette garde, pas ce chemin.
      const claimedDelivery = await tx.delivery.updateMany({
        where: {
          id,
          status: delivery.status,
          // Comme `confirmPickup` : un livreur dessaisi entre sa lecture et son
          // écriture ne conclut pas la course de son successeur (cf. F-03).
          ...(user.role === 'LIVREUR' ? { delivererId: user.id } : {}),
        },
        data: {
          status,
          ...(status === DeliveryStatus.LIVRER
            ? {
                deliveredAt: now,
                handoverMethod: handover!.method,
                handoverVerifiedAt:
                  handover!.method === DeliveryHandoverMethod.CODE ? now : null,
              }
            : {}),
          // Un échec détache le livreur ET efface l'économie de la course.
          // Les deux vont ensemble : garder le montant après avoir retiré son
          // titulaire laisserait une rémunération due à personne, que le
          // calcul de contribution compterait. Et puisque seul le livreur qui
          // TERMINE est payé, une tentative échouée n'a pas d'économie.
          ...(status === DeliveryStatus.ECHEC
            ? { delivererId: null, ...CLEARED_DRIVER_ECONOMICS }
            : {}),
        },
      });
      if (claimedDelivery.count === 0) {
        throw new ConflictException(
          'Cette livraison a changé d’état entre-temps. Rechargez la mission avant de réessayer.',
        );
      }

      if (status === DeliveryStatus.LIVRER) {
        // `transition` et non `tryTransition` : ici, une commande qui a bougé
        // EST une erreur. Elle lève, donc la transaction est annulée — la
        // livraison repasse dans l'état où elle était.
        await this.transitions.transition(tx, {
          orderId: delivery.orderId,
          from: previousOrderStatus,
          to: OrderStatus.LIVRER,
          actor: actorRole!,
          actorUserId: user.id,
          source: sourceFromRole(user.role),
        });
      }

      // Libère le livreur dans les 2 cas (LIVRER ou ECHEC)
      if (
        (status === DeliveryStatus.LIVRER ||
          status === DeliveryStatus.ECHEC) &&
        delivery.delivererId
      ) {
        await tx.user.update({
          where: { id: delivery.delivererId },
          data: { driverStatus: DriverStatus.AVAILABLE },
        });
      }

      // Clôture de la main en cours, dans la MÊME transaction que le statut.
      // `COMPLETED` est le seul cas où une rémunération est due — c'est la
      // ligne de journal qui dit lequel des livreurs successifs a terminé,
      // information que `Delivery.delivererId` perdait à chaque réassignation.
      await this.assignmentLog.close(
        tx,
        id,
        status === DeliveryStatus.LIVRER
          ? DeliveryAssignmentOutcome.COMPLETED
          : DeliveryAssignmentOutcome.FAILED,
        reason,
        now,
      );

      // Lot 4 — fidélité et parrainage : obligation durable écrite avec la
      // transition `LIVRER` (le déclenchement immédiat ci-dessous reste, pour
      // la latence ; l'outbox rattrape un processus mort entre les deux).
      if (status === DeliveryStatus.LIVRER) {
        await this.outbox.enqueueInTransaction(tx, {
          type: ORDER_DELIVERED_EVENT,
          aggregateId: delivery.orderId,
          payload: {},
        });
      }
    });

    const updated = await this.prisma.delivery.findUnique({
      where: { id },
      include: {
        order: true,
        deliverer: { select: { id: true, nom: true, phone: true } },
      },
    });

    // Émet l'event order.status.updated → OrdersListener notifie le client + WS
    if (handover?.method === DeliveryHandoverMethod.ADMIN_OVERRIDE) {
      await this.audit.record({
        actorId: user.id,
        action: AdminAuditAction.ORDER_STATUS_FORCED,
        targetType: 'Order',
        targetId: delivery.orderId,
        reason: reason ?? null,
        metadata: {
          from: previousOrderStatus,
          to: OrderStatus.LIVRER,
          handover: 'ADMIN_OVERRIDE',
          deliveryId: id,
        },
      });
    }

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

      // Récompenses à la livraison (non-bloquantes).
      //
      // Implémentations uniques et idempotentes : l'autre chemin vers LIVRER
      // (`PATCH /orders/:id/status`) appelle exactement les mêmes services, et
      // leur idempotence est portée par la base — `@@unique([orderId, type])`
      // pour la fidélité, `ReferralReward.referredUserId @unique` pour le
      // parrainage. Deux passages concurrents produisent un seul crédit.
      this.loyalty
        .awardForDeliveredOrder(delivery.order.userId, delivery.orderId)
        .catch((err) => this.logger.error(`Erreur points fidélité: ${err}`));

      this.referral
        .rewardForDeliveredOrder(delivery.order.userId, delivery.orderId)
        .catch((err) =>
          this.logger.error(`Erreur récompense parrainage: ${err}`),
        );
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
          // `delivery` a été lue avant la mise à jour : c'est bien l'état
          // d'origine, celui qui dit si le repas avait quitté le comptoir.
          delivery.status,
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

  /** Le livreur refuse une mission qu'il n'a pas encore acceptée. */
  async declineDelivery(
    deliveryId: string,
    firebaseUid: string,
    reason?: string,
  ) {
    return this.assignmentService.declineDelivery(
      deliveryId,
      firebaseUid,
      reason,
    );
  }

  /**
   * Le livreur confirme avoir récupéré le repas au restaurant.
   * C'est ce geste — et non l'acceptation — qui met la commande EN_ROUTE et
   * prévient le client.
   */
  async confirmPickup(deliveryId: string, firebaseUid: string) {
    return this.assignmentService.confirmPickup(deliveryId, firebaseUid);
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
   * livraisons `EN_TRANSIT` simultanées pour un seul téléphone : la position
   * publiée ne peut décrire qu'une des deux courses, et l'autre client suit un
   * livreur qui ne vient pas chez lui.
   */
  async setDriverStatus(firebaseUid: string, status: DriverStatus) {
    const user = await this.getUserOrThrow(firebaseUid); // 404 si introuvable (plus de TypeError 500)
    if (user.role !== 'LIVREUR') throw new ForbiddenException();

    if (status === DriverStatus.AVAILABLE || status === DriverStatus.OFFLINE) {
      const activeDelivery = await this.prisma.delivery.findFirst({
        where: {
          delivererId: user.id,
          status: { in: ACTIVE_DELIVERY_STATUSES },
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
