import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  DeliveryAssignmentOutcome,
  DeliveryStatus,
  DispatchOutcome,
  DriverStatus,
  OrderStatus,
  Role,
  StatusUser,
} from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { PlatformSettingsService } from '../platform-settings/platform-settings.service';
import { computeDriverCompensation } from '../drivers/driver-compensation';
import { releaseDriverIfIdle } from '../drivers/driver-release';
import { OutboxService } from '../outbox/outbox.service';
import {
  DeliveryAcceptedEvent,
  DeliveryUnassignedEvent,
} from '../events/delivery-events';
import { DeliveryAssignmentLogService } from './delivery-assignment-log.service';
import { CLEARED_DRIVER_ECONOMICS } from './delivery-assignment.service';
import { projectDeliveryForDriver } from './delivery-driver-projection';
import { ACTIVE_DELIVERY_STATUSES } from './delivery-statuses';
import {
  ALREADY_TAKEN_MESSAGE,
  CLAIMABLE_DELIVERY_WHERE,
  CLAIM_ERROR,
  DELIVERY_DISPATCH_REQUESTED_EVENT,
  FCFS_ASSIGNED_BY_ROLE,
  closedDispatchData,
  isDispatchOpen,
  openedDispatchData,
  readDispatchEnabled,
} from './dispatch/dispatch-policy';
import {
  driverAccountWhere,
  driverProfileWhere,
} from './dispatch/dispatch-eligibility';
import {
  DeliveryDispatchService,
  DispatchRequestedPayload,
  OpenedDispatch,
} from './dispatch/delivery-dispatch.service';

/** Statuts où une course appartient à son livreur (rejeu du claim). */
const HELD_BY_DRIVER: DeliveryStatus[] = [
  DeliveryStatus.ACCEPTER,
  DeliveryStatus.EN_TRANSIT,
  DeliveryStatus.LIVRER,
];

function conflict(code: string, message: string): ConflictException {
  return new ConflictException({ code, message });
}

function notEligible(message: string): ForbiddenException {
  return new ForbiddenException({ code: CLAIM_ERROR.NOT_ELIGIBLE, message });
}

/**
 * Prise d'une course par un livreur — le cœur du FCFS (10/11/2026).
 *
 * **Le premier claim validé par PostgreSQL gagne.** Pas un verrou applicatif,
 * pas Redis : un `UPDATE … WHERE status = EN_ATTENTE AND delivererId IS NULL`
 * dont PostgreSQL garantit qu'une seule transaction voit la ligne encore
 * libre. Les perdants, mis en attente sur le verrou de ligne, relisent après
 * le commit du gagnant (READ COMMITTED) et ne trouvent plus rien : 409.
 *
 * Ordre global des verrous (F3-12.0), le même que l'acceptation :
 * R1 `Order` FOR SHARE → R2 `Delivery` (CAS) → R4 `User` (CAS) → R5 profil.
 * Toute exception annule tout : un claim refusé ne laisse ni course prise,
 * ni livreur `ON_DELIVERY`.
 */
@Injectable()
export class DeliveryClaimService {
  private readonly logger = new Logger(DeliveryClaimService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
    private readonly platformSettings: PlatformSettingsService,
    private readonly assignmentLog: DeliveryAssignmentLogService,
    private readonly outbox: OutboxService,
    private readonly dispatch: DeliveryDispatchService,
  ) {}

  private async driverOrThrow(firebaseUid: string) {
    const user = await this.prisma.user.findUnique({
      where: { firebaseUid },
      include: {
        driverProfile: {
          select: {
            employmentType: true,
            compensationModel: true,
            driverSharePercent: true,
          },
        },
      },
    });
    if (!user) throw new NotFoundException('Utilisateur non trouvé.');
    return user;
  }

  /** `GET /deliveries/available`. */
  async listAvailable(firebaseUid: string, page?: number, limit?: number) {
    const user = await this.prisma.user.findUnique({
      where: { firebaseUid },
      select: { id: true },
    });
    if (!user) throw new NotFoundException('Utilisateur non trouvé.');
    return this.dispatch.listOpenForDriver(
      user.id,
      page ?? 1,
      Math.min(limit ?? 20, 50),
    );
  }

  /** `POST /deliveries/:id/claim`. */
  async claim(deliveryId: string, firebaseUid: string) {
    const user = await this.driverOrThrow(firebaseUid);
    const delivery = await this.prisma.delivery.findUnique({
      where: { id: deliveryId },
      select: {
        id: true,
        orderId: true,
        status: true,
        delivererId: true,
        order: {
          select: {
            userId: true,
            restaurantId: true,
            deliveryFeeGross: true,
            restaurant: { select: { nom: true, quartierId: true } },
          },
        },
      },
    });
    if (!delivery) throw new NotFoundException('Course introuvable.');

    // Rejeu du gagnant (double appui, réseau qui retente) : 200, rien d'écrit.
    if (
      delivery.delivererId === user.id &&
      HELD_BY_DRIVER.includes(delivery.status)
    ) {
      return this.replayed(deliveryId);
    }

    // Même calcul que l'acceptation historique : le gel se fait au moment où
    // le contrat se forme, au tarif AVANT remise (`deliveryFeeGross`).
    const settings = await this.platformSettings.getSettings();
    const compensation = computeDriverCompensation({
      profile: user.driverProfile,
      settings,
      baseXaf: delivery.order.deliveryFeeGross,
    });
    const now = new Date();
    const quartierId = delivery.order.restaurant.quartierId;

    const outcome = await this.prisma.$transaction(async (tx) => {
      // ── R1 : la commande, en lecture partagée ─────────────────────────
      // Une annulation concurrente (`UPDATE "Order"`) attend notre commit,
      // ou nous attendons la sienne et lisons `ANNULER`.
      const [order] = await tx.$queryRaw<{ status: OrderStatus }[]>`
        SELECT status FROM "Order" WHERE id = ${delivery.orderId} FOR SHARE
      `;
      if (!order) throw new NotFoundException('Commande non trouvée.');
      if (order.status !== OrderStatus.PRET) {
        throw conflict(
          CLAIM_ERROR.ORDER_NOT_READY,
          'Cette commande n’est plus disponible.',
        );
      }
      if (!(await readDispatchEnabled(tx))) {
        throw conflict(
          CLAIM_ERROR.DISPATCH_CLOSED,
          'Cette commande n’est plus proposée aux livreurs.',
        );
      }

      // ── R2 : LE claim ─────────────────────────────────────────────────
      const claimed = await tx.delivery.updateMany({
        where: { id: deliveryId, ...CLAIMABLE_DELIVERY_WHERE },
        data: {
          delivererId: user.id,
          status: DeliveryStatus.ACCEPTER,
          acceptedAt: now,
          // Économie indéterminable (pas de profil) : `null` dit la vérité ;
          // rien d'une main précédente ne doit survivre (D-3).
          ...(compensation
            ? {
                driverBaseXaf: compensation.baseXaf,
                driverEmploymentType: compensation.employmentType,
                driverCompensationModel: compensation.compensationModel,
                driverSharePercent: compensation.driverSharePercent,
                driverPayXaf: compensation.driverPayXaf,
                driverEconomicsFrozenAt: now,
              }
            : CLEARED_DRIVER_ECONOMICS),
          ...closedDispatchData(now, DispatchOutcome.ASSIGNED),
        },
      });
      if (claimed.count === 0) {
        const current = await tx.delivery.findUnique({
          where: { id: deliveryId },
          select: {
            delivererId: true,
            status: true,
            dispatchStartedAt: true,
            dispatchEndedAt: true,
            dispatchOutcome: true,
          },
        });
        // Deux requêtes du même livreur : la première a gagné.
        if (current?.delivererId === user.id) return 'replayed' as const;
        if (current?.delivererId) {
          throw conflict(CLAIM_ERROR.ALREADY_TAKEN, ALREADY_TAKEN_MESSAGE);
        }
        if (current && !isDispatchOpen(current)) {
          throw conflict(
            CLAIM_ERROR.DISPATCH_CLOSED,
            'Cette commande n’est plus proposée aux livreurs.',
          );
        }
        throw conflict(CLAIM_ERROR.ALREADY_TAKEN, ALREADY_TAKEN_MESSAGE);
      }

      // ── R4 : le livreur, AVAILABLE → ON_DELIVERY ──────────────────────
      // Le compte fait partie de l'état revendiqué : un ban ou un rôle
      // changé à l'instant (cache de `RolesGuard`) fait échouer ce CAS.
      const driverClaimed = await tx.user.updateMany({
        where: {
          id: user.id,
          ...driverAccountWhere(),
          driverStatus: DriverStatus.AVAILABLE,
        },
        data: { driverStatus: DriverStatus.ON_DELIVERY },
      });
      if (driverClaimed.count === 0) {
        const current = await tx.user.findUnique({
          where: { id: user.id },
          select: {
            role: true,
            statusUser: true,
            banPendingAt: true,
            driverStatus: true,
          },
        });
        if (
          current?.role !== Role.LIVREUR ||
          current.statusUser !== StatusUser.ACTIVE ||
          current.banPendingAt
        ) {
          throw notEligible(
            'Votre compte ne permet plus d’accepter de course.',
          );
        }
        if (current.driverStatus === DriverStatus.ON_DELIVERY) {
          throw conflict(
            CLAIM_ERROR.DRIVER_BUSY,
            "Vous avez déjà une livraison en cours. Terminez-la avant d'en accepter une autre.",
          );
        }
        throw notEligible('Passez « Disponible » pour accepter une livraison.');
      }

      // ── R5 : profil (en service, app capable, zone) ───────────────────
      const profileOk = await tx.driverProfile.count({
        where: { userId: user.id, ...driverProfileWhere(quartierId) },
      });
      if (profileOk === 0) {
        throw notEligible(
          'Cette commande ne vous est pas proposée (profil hors service, application à mettre à jour ou zone différente).',
        );
      }
      // Une mission encore `ASSIGNER` ne pose pas `ON_DELIVERY` : on la
      // compte ici, faute de quoi le livreur tiendrait deux courses.
      const others = await tx.delivery.count({
        where: {
          delivererId: user.id,
          id: { not: deliveryId },
          status: { in: ACTIVE_DELIVERY_STATUSES },
        },
      });
      if (others > 0) {
        throw conflict(
          CLAIM_ERROR.DRIVER_BUSY,
          "Vous avez déjà une mission. Terminez-la avant d'en accepter une autre.",
        );
      }

      // Journal dans la même transaction. L'index unique partiel « une main
      // ouverte par course » est la seconde garantie : un second gagnant
      // impossible mourrait ici en P2002, et toute la transaction avec lui.
      await this.assignmentLog.open(tx, {
        deliveryId,
        orderId: delivery.orderId,
        delivererId: user.id,
        assignedByUserId: null,
        assignedByRole: FCFS_ASSIGNED_BY_ROLE,
        assignedAt: now,
      });
      await this.assignmentLog.markAccepted(tx, deliveryId, now);
      return 'claimed' as const;
    });

    if (outcome === 'replayed') return this.replayed(deliveryId);

    this.logger.log(
      `🛵 Course ${deliveryId} prise par le livreur ${user.id} (commande ${delivery.orderId})`,
    );
    // Le vendeur sait qu'un livreur vient ; la commande reste `PRET`, le
    // client n'apprend rien tant que le repas n'a pas quitté le comptoir.
    this.events.emit(
      'delivery.accepted',
      new DeliveryAcceptedEvent(
        deliveryId,
        delivery.orderId,
        delivery.order.restaurantId,
        user.id,
        user.nom,
      ),
    );
    this.dispatch
      .announceOfferWithdrawn(deliveryId, quartierId, 'ASSIGNED', user.id)
      .catch((err) =>
        this.logger.warn(
          `Push « course prise » non envoyé (${deliveryId}) : ${(err as Error).message}`,
        ),
      );

    const row = await this.prisma.delivery.findUniqueOrThrow({
      where: { id: deliveryId },
    });
    // D-PAY : route LIVREUR — liste blanche, ni gain ni montant.
    return {
      data: projectDeliveryForDriver(row),
      message: 'Livraison acceptée. Rendez-vous au point de retrait.',
    };
  }

  private async replayed(deliveryId: string) {
    const row = await this.prisma.delivery.findUniqueOrThrow({
      where: { id: deliveryId },
    });
    return {
      data: projectDeliveryForDriver(row),
      message: 'Cette livraison vous est déjà attribuée.',
    };
  }

  /**
   * `POST /deliveries/:id/abandon` — « Je ne peux plus effectuer cette
   * livraison », **avant** la récupération seulement.
   *
   * La course redevient `EN_ATTENTE` sans titulaire, son économie est
   * effacée (seul celui qui termine est payé, D-3), la main est fermée en
   * `DECLINED` avec le motif, le livreur est libéré par le seul point de
   * libération (`releaseDriverIfIdle`, R5) et la recherche est rouverte.
   * Après la récupération, le chemin reste le protocole d'échec F3-05.
   */
  async abandon(deliveryId: string, firebaseUid: string, reason: string) {
    const user = await this.driverOrThrow(firebaseUid);
    const delivery = await this.prisma.delivery.findUnique({
      where: { id: deliveryId },
      select: {
        id: true,
        orderId: true,
        status: true,
        delivererId: true,
        order: { select: { restaurantId: true } },
      },
    });
    if (!delivery) throw new NotFoundException('Course introuvable.');
    if (delivery.delivererId !== user.id) {
      throw new ForbiddenException('Cette livraison ne vous est pas assignée');
    }
    if (delivery.status !== DeliveryStatus.ACCEPTER) {
      throw conflict(
        'ABANDON_NOT_ALLOWED',
        delivery.status === DeliveryStatus.EN_TRANSIT
          ? 'Vous avez déjà récupéré la commande : signalez un échec de livraison.'
          : 'Cette mission ne peut plus être rendue.',
      );
    }

    const now = new Date();
    const motive = reason.trim();

    const opened = await this.prisma.$transaction(
      async (tx): Promise<OpenedDispatch | null> => {
        const [order] = await tx.$queryRaw<{ status: OrderStatus }[]>`
          SELECT status FROM "Order" WHERE id = ${delivery.orderId} FOR SHARE
        `;
        if (order?.status !== OrderStatus.PRET) {
          throw conflict(
            'ABANDON_NOT_ALLOWED',
            'La commande n’est plus au point de retrait : signalez un échec de livraison.',
          );
        }
        const enabled = await readDispatchEnabled(tx);
        const released = await tx.delivery.updateMany({
          where: {
            id: deliveryId,
            status: DeliveryStatus.ACCEPTER,
            delivererId: user.id,
            pickedUpAt: null,
          },
          data: {
            status: DeliveryStatus.EN_ATTENTE,
            delivererId: null,
            acceptedAt: null,
            ...CLEARED_DRIVER_ECONOMICS,
            ...(enabled ? openedDispatchData(now) : {}),
          },
        });
        if (released.count === 0) {
          throw new ConflictException(
            'Cette mission a changé d’état entre-temps. Rechargez vos missions.',
          );
        }
        await this.assignmentLog.close(
          tx,
          deliveryId,
          DeliveryAssignmentOutcome.DECLINED,
          `Désistement avant récupération : ${motive}`,
          now,
        );
        await releaseDriverIfIdle(tx, user.id);

        if (!enabled) return null;
        const outboxId = await this.outbox.enqueueInTransaction(tx, {
          type: DELIVERY_DISPATCH_REQUESTED_EVENT,
          aggregateId: deliveryId,
          payload: {
            deliveryId,
            orderId: delivery.orderId,
            cause: 'DRIVER_ABANDONED',
          } satisfies DispatchRequestedPayload,
        });
        return { deliveryId, orderId: delivery.orderId, outboxId };
      },
    );

    this.events.emit(
      'delivery.unassigned',
      new DeliveryUnassignedEvent(
        deliveryId,
        delivery.orderId,
        delivery.order.restaurantId,
        user.id,
        'abandoned',
        motive,
      ),
    );
    if (opened) await this.dispatch.afterOpen(opened);

    return {
      data: { deliveryId, status: DeliveryStatus.EN_ATTENTE },
      message: opened
        ? 'Mission rendue. Elle est de nouveau proposée aux livreurs.'
        : 'Mission rendue.',
    };
  }
}
