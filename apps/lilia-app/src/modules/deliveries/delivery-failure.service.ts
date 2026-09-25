import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  AdminAuditAction,
  DeliveryAssignmentOutcome,
  DeliveryFailureReason,
  DeliveryStatus,
  DriverStatus,
  FailureLiability,
  OrderStatus,
  PayoutStatus,
  RefundReasonCode,
  RefundStatus,
  User,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { haversineKm } from '../../common/geo/congo-geo';
import { AdminAuditService } from '../admin-audit/admin-audit.service';
import { DeliveryFailedEvent } from '../events/delivery-events';
import { OrderStatusUpdatedEvent } from '../events/order-events';
import { NotificationsService } from '../notifications/notifications.service';
import { OrderTransitionService } from '../orders/order-transition.service';
import { SmsService } from '../sms/sms.service';
import { CLEARED_DRIVER_ECONOMICS } from './delivery-assignment.service';
import { DeliveryAssignmentLogService } from './delivery-assignment-log.service';
import {
  AUTO_REFUND_REASON_CODES,
  COUNTED_REFUND_STATUSES,
  defaultBearer,
} from '../refunds/refund-lines.policy';
import {
  clientLiabilityGaps,
  FAILURE_OUTCOMES,
  protocolWaitRemainingSeconds,
} from './delivery-failure.policy';

/** Statuts où le repas n'a pas encore quitté le comptoir. */
const BEFORE_PICKUP: DeliveryStatus[] = [
  DeliveryStatus.EN_ATTENTE,
  DeliveryStatus.ASSIGNER,
  DeliveryStatus.ACCEPTER,
];
/** Statuts de commande depuis lesquels un échec se conclut (R-05.1). */
const CONCLUDABLE: OrderStatus[] = [OrderStatus.PRET, OrderStatus.EN_ROUTE];

export interface DeclareFailureInput {
  reason: DeliveryFailureReason;
  note?: string;
  latitude?: number;
  longitude?: number;
}

/**
 * Échec de livraison et responsabilité (F3-05).
 *
 *  1. **Protocole** « client injoignable » (livreur titulaire, en course) :
 *     SMS au client, appels journalisés, 10 min d'attente.
 *  2. **Déclaration** : le livreur (en course) ou le vendeur (avant la
 *     récupération) dit ce qui s'est passé. La livraison passe `ECHEC` ; la
 *     commande **ne bouge pas** — la déclaration n'est pas un geste d'argent.
 *  3. **Conclusion** par l'admin, avec un responsable : la commande passe
 *     `ECHEC_LIVRAISON` et la matrice R-05.3 décide du remboursement, du
 *     reversement vendeur et de la paie livreur.
 *
 * Entre 2 et 3, l'admin peut aussi **réassigner** (chemin existant) : la course
 * repart avec un autre livreur et la paie de l'échec est effacée.
 */
@Injectable()
export class DeliveryFailureService {
  private readonly logger = new Logger(DeliveryFailureService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly transitions: OrderTransitionService,
    private readonly assignmentLog: DeliveryAssignmentLogService,
    private readonly audit: AdminAuditService,
    private readonly sms: SmsService,
    private readonly notifications: NotificationsService,
    private readonly events: EventEmitter2,
  ) {}

  // ─── 1. Protocole « client injoignable » ──────────────────────────────────

  async startUnreachable(deliveryId: string, driver: User) {
    const delivery = await this.titularInTransit(deliveryId, driver);
    const open = await this.openReport(deliveryId);
    // Idempotent : un second appui ne renvoie pas de SMS au client.
    if (open?.protocolStartedAt) return this.protocolState(open);

    const now = new Date();
    const phone = delivery.order.contactPhone ?? delivery.order.user.phone;
    const smsOutcome = phone
      ? await this.sms.send(
          phone,
          `Lilia Food : votre livreur est à votre adresse avec la commande #${delivery.orderId.slice(-6).toUpperCase()} et n'arrive pas à vous joindre. Appelez-le ou répondez à son appel.`,
        )
      : 'SKIPPED';

    const report = open
      ? await this.prisma.deliveryFailureReport.update({
          where: { id: open.id },
          data: {
            protocolStartedAt: now,
            smsSentAt: smsOutcome === 'SENT' ? now : null,
          },
        })
      : await this.prisma.deliveryFailureReport.create({
          data: {
            deliveryId,
            orderId: delivery.orderId,
            reportedBy: driver.id,
            reportedByRole: driver.role,
            reason: DeliveryFailureReason.CUSTOMER_UNREACHABLE,
            protocolStartedAt: now,
            smsSentAt: smsOutcome === 'SENT' ? now : null,
          },
        });

    await this.notifications
      .sendPushNotification(
        delivery.order.userId,
        '📍 Votre livreur est devant chez vous',
        "Il n'arrive pas à vous joindre : appelez-le ou décrochez.",
        { orderId: delivery.orderId, type: 'delivery_unreachable' },
      )
      .catch((err) => this.logger.warn(`Push injoignable non parti : ${err}`));

    return this.protocolState(report);
  }

  /** Une tentative d'appel. L'app appelle elle-même ; le serveur compte. */
  async logCall(deliveryId: string, driver: User) {
    await this.titularInTransit(deliveryId, driver);
    const open = await this.openReport(deliveryId);
    if (!open?.protocolStartedAt) {
      throw new BadRequestException(
        'Démarrez d’abord le protocole « client injoignable ».',
      );
    }
    const report = await this.prisma.deliveryFailureReport.update({
      where: { id: open.id },
      data: { callAttempts: { increment: 1 } },
    });
    return this.protocolState(report);
  }

  // ─── 2. Déclaration ───────────────────────────────────────────────────────

  async declare(deliveryId: string, user: User, input: DeclareFailureInput) {
    const delivery = await this.prisma.delivery.findUnique({
      where: { id: deliveryId },
      include: {
        order: {
          include: {
            restaurant: {
              select: { nom: true, owner: { select: { id: true } } },
            },
          },
        },
      },
    });
    if (!delivery) throw new NotFoundException('Livraison introuvable.');

    const isTitular = delivery.delivererId === user.id;
    const isVendor = delivery.order.restaurant.owner.id === user.id;
    const isAdmin = user.role === 'ADMIN';
    const inTransit = delivery.status === DeliveryStatus.EN_TRANSIT;
    const beforePickup = BEFORE_PICKUP.includes(delivery.status);

    if (!inTransit && !beforePickup) {
      throw new ConflictException(
        `Cette livraison est « ${delivery.status} » : aucun échec ne peut plus y être déclaré.`,
      );
    }
    // Le vendeur ne déclare qu'avant la récupération : une fois le repas
    // parti, il n'est plus chez lui et il ne sait pas ce qui s'est passé
    // (défaut P3 du Master §11).
    const allowed =
      isAdmin ||
      (isTitular &&
        (inTransit || delivery.status === DeliveryStatus.ACCEPTER)) ||
      (isVendor && beforePickup);
    if (!allowed) {
      throw new ForbiddenException(
        isVendor
          ? 'Le repas est parti avec le livreur : seul lui ou l’administration peut déclarer l’échec.'
          : "Vous n'êtes pas autorisé à déclarer l'échec de cette livraison.",
      );
    }

    const open = await this.openReport(deliveryId);
    // R-05.4 côté livreur : « Déclarer l'échec » n'est permis qu'après
    // l'attente du protocole. Le serveur le refuse, l'app ne fait qu'afficher.
    if (
      input.reason === DeliveryFailureReason.CUSTOMER_UNREACHABLE &&
      isTitular &&
      !isAdmin
    ) {
      const remaining = protocolWaitRemainingSeconds(
        open?.protocolStartedAt ?? null,
        new Date(),
      );
      if (remaining === null) {
        throw new BadRequestException(
          'Démarrez le protocole « client injoignable » avant de déclarer.',
        );
      }
      if (remaining > 0) {
        throw new BadRequestException(
          `Attendez encore ${Math.ceil(remaining / 60)} min avant de déclarer le client injoignable.`,
        );
      }
    }

    const now = new Date();
    const distanceToDestM =
      input.latitude != null &&
      input.longitude != null &&
      delivery.order.deliveryLatitude != null &&
      delivery.order.deliveryLongitude != null
        ? Math.round(
            haversineKm(
              input.latitude,
              input.longitude,
              delivery.order.deliveryLatitude,
              delivery.order.deliveryLongitude,
            ) * 1000,
          )
        : null;

    await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.delivery.updateMany({
        where: {
          id: deliveryId,
          status: delivery.status,
          delivererId: delivery.delivererId,
        },
        data: {
          status: DeliveryStatus.ECHEC,
          failedAt: now,
          // Avant la récupération, rien n'a roulé : le livreur est détaché et
          // la course redevient assignable, sans paie (comme avant F3-05).
          // En course, il reste titulaire, avec son économie gelée, jusqu'à
          // la conclusion : c'est elle qui dira s'il est payé.
          ...(inTransit
            ? {}
            : { delivererId: null, ...CLEARED_DRIVER_ECONOMICS }),
        },
      });
      if (claimed.count === 0) {
        throw new ConflictException(
          'Cette livraison a changé d’état entre-temps. Rechargez-la avant de réessayer.',
        );
      }
      if (delivery.delivererId) {
        await tx.user.updateMany({
          where: {
            id: delivery.delivererId,
            driverStatus: DriverStatus.ON_DELIVERY,
          },
          data: { driverStatus: DriverStatus.AVAILABLE },
        });
      }
      await this.assignmentLog.close(
        tx,
        deliveryId,
        DeliveryAssignmentOutcome.FAILED,
        input.note ?? input.reason,
        now,
      );
      const data = {
        reason: input.reason,
        note: input.note?.trim() || null,
        latitude: input.latitude ?? null,
        longitude: input.longitude ?? null,
        distanceToDestM,
        declaredAt: now,
      };
      if (open) {
        await tx.deliveryFailureReport.update({ where: { id: open.id }, data });
      } else {
        await tx.deliveryFailureReport.create({
          data: {
            ...data,
            deliveryId,
            orderId: delivery.orderId,
            reportedBy: user.id,
            reportedByRole: user.role,
          },
        });
      }
    });

    // Notifications, incident et cockpit : portés par `DeliveriesListener`
    // sur l'événement existant — un seul chemin pour « la livraison a échoué ».
    this.events.emit(
      'delivery.failed',
      new DeliveryFailedEvent(
        delivery.id,
        delivery.orderId,
        delivery.order.restaurantId,
        delivery.order.userId,
        delivery.delivererId,
        delivery.order.restaurant.nom,
        input.note ?? input.reason,
        user.id,
        delivery.status,
      ),
    );
    return { deliveryId, status: DeliveryStatus.ECHEC, distanceToDestM };
  }

  // ─── 3. Conclusion (ADMIN) ────────────────────────────────────────────────

  /**
   * Conclut l'échec : commande → `ECHEC_LIVRAISON` et effets d'argent selon
   * le responsable. `dryRun` rend les montants sans rien écrire — l'écran
   * d'arbitrage les affiche avant validation.
   */
  async conclude(
    orderId: string,
    admin: User,
    liability: FailureLiability,
    dryRun: boolean,
  ) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: {
        delivery: {
          include: {
            failureReports: {
              where: { declaredAt: { not: null } },
              orderBy: { declaredAt: 'desc' },
              take: 1,
            },
          },
        },
        Payment: {
          where: { status: 'SUCCESS' },
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
        payout: { select: { status: true } },
        refunds: { select: { status: true, amount: true, reasonCode: true } },
        restaurant: { select: { nom: true } },
      },
    });
    if (!order) throw new NotFoundException('Commande introuvable.');
    if (!CONCLUDABLE.includes(order.status)) {
      throw new ConflictException(
        `La commande est « ${order.status} » : un échec ne se conclut que depuis PRET ou EN_ROUTE.`,
      );
    }
    const delivery = order.delivery;
    if (!delivery || delivery.status !== DeliveryStatus.ECHEC) {
      throw new ConflictException(
        "Aucun échec déclaré sur cette livraison : réassignez un livreur, ou faites d'abord déclarer l'échec.",
      );
    }
    const report = delivery.failureReports[0] ?? null;

    if (liability === FailureLiability.CLIENT) {
      const gaps = clientLiabilityGaps(
        {
          reason: report?.reason ?? null,
          callAttempts: report?.callAttempts ?? 0,
          smsSentAt: report?.smsSentAt ?? null,
          protocolStartedAt: report?.protocolStartedAt ?? null,
          declaredAt: report?.declaredAt ?? null,
          distanceToDestM: report?.distanceToDestM ?? null,
        },
        order.deliveryPrecision === 'EXACT',
      );
      if (gaps.length) {
        throw new ConflictException(
          `Le client ne peut pas être tenu responsable : ${gaps.join(' ')} La plateforme assume (PLATFORM).`,
        );
      }
    }

    const outcome = FAILURE_OUTCOMES[liability];
    const payout = order.payout?.status;
    // F-04 : on ne tranche pas pendant qu'un reversement est en vol.
    if (payout === PayoutStatus.PENDING) {
      throw new ConflictException(
        'Un reversement vendeur est en cours sur cette commande : attendez son issue avant de conclure.',
      );
    }
    if (!outcome.payVendor && payout === PayoutStatus.SUCCESS) {
      throw new ConflictException(
        'Le vendeur a déjà été payé : le reprendre (clawback) n’existe pas encore (F3-07). Concluez avec un autre responsable ou réglez hors système.',
      );
    }

    // F3-06 — N remboursements par commande : on rembourse ce qui reste dû,
    // et jamais deux fois l'échec (un seul remboursement automatique).
    const counted = order.refunds.filter((r) =>
      COUNTED_REFUND_STATUSES.includes(r.status),
    );
    const alreadyAuto = order.refunds.some((r) =>
      AUTO_REFUND_REASON_CODES.includes(r.reasonCode),
    );
    const paid = Math.max(
      0,
      (order.Payment[0]?.amount ?? 0) -
        counted.reduce((sum, r) => sum + r.amount, 0),
    );
    const refundXaf = outcome.refundClient && !alreadyAuto ? paid : 0;
    const summary = {
      orderId,
      liability,
      refundXaf,
      vendorPaid: outcome.payVendor,
      driverPayXaf: outcome.payDriver ? (delivery.driverPayXaf ?? 0) : 0,
      reason: report?.reason ?? null,
    };
    if (dryRun) return { ...summary, dryRun: true };

    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      await this.transitions.transition(tx, {
        orderId,
        from: order.status,
        to: OrderStatus.ECHEC_LIVRAISON,
        actor: 'ADMIN',
        actorUserId: admin.id,
        source: 'ADMIN_APP',
        reason: `Échec de livraison — responsable : ${liability}`,
        data: {
          failedAt: now,
          failureReason: report?.reason ?? null,
          failureLiability: liability,
          failureDecidedBy: admin.id,
        },
      });
      if (!outcome.payDriver) {
        await tx.delivery.update({
          where: { id: delivery.id },
          data: { driverPayXaf: 0 },
        });
      }
      if (refundXaf > 0) {
        await tx.refund.create({
          data: {
            orderId,
            paymentId: order.Payment[0].id,
            amount: refundXaf,
            reason: `Échec de livraison (${liability})`,
            reasonCode: RefundReasonCode.DELIVERY_FAILED,
            bearer: defaultBearer(RefundReasonCode.DELIVERY_FAILED, liability),
            requestedBy: admin.id,
            status: RefundStatus.PENDING,
          },
        });
      }
    });

    await this.audit.record({
      actorId: admin.id,
      action: AdminAuditAction.ORDER_FAILURE_CONCLUDED,
      targetType: 'Order',
      targetId: orderId,
      reason: report?.reason ?? null,
      metadata: summary,
    });
    this.events.emit(
      'order.status.updated',
      new OrderStatusUpdatedEvent(
        orderId,
        order.userId,
        order.restaurantId,
        order.status,
        OrderStatus.ECHEC_LIVRAISON,
        admin.id,
        { restaurantName: order.restaurant.nom, totalAmount: order.total },
      ),
    );
    return { ...summary, dryRun: false };
  }

  /** Preuves d'un échec, pour l'écran d'arbitrage. */
  async evidence(orderId: string) {
    return this.prisma.deliveryFailureReport.findMany({
      where: { orderId },
      orderBy: { createdAt: 'asc' },
    });
  }

  // ─── Outils ───────────────────────────────────────────────────────────────

  private async titularInTransit(deliveryId: string, driver: User) {
    const delivery = await this.prisma.delivery.findUnique({
      where: { id: deliveryId },
      include: { order: { include: { user: { select: { phone: true } } } } },
    });
    if (!delivery) throw new NotFoundException('Livraison introuvable.');
    if (delivery.delivererId !== driver.id) {
      throw new ForbiddenException("Cette course n'est pas la vôtre.");
    }
    if (delivery.status !== DeliveryStatus.EN_TRANSIT) {
      throw new ConflictException(
        'Le protocole ne concerne qu’une course en cours de livraison.',
      );
    }
    return delivery;
  }

  private openReport(deliveryId: string) {
    return this.prisma.deliveryFailureReport.findFirst({
      where: { deliveryId, declaredAt: null },
      orderBy: { createdAt: 'desc' },
    });
  }

  private protocolState(report: {
    id: string;
    callAttempts: number;
    smsSentAt: Date | null;
    protocolStartedAt: Date | null;
  }) {
    return {
      reportId: report.id,
      callAttempts: report.callAttempts,
      smsSent: report.smsSentAt != null,
      protocolStartedAt: report.protocolStartedAt,
      waitRemainingSeconds: protocolWaitRemainingSeconds(
        report.protocolStartedAt,
        new Date(),
      ),
    };
  }
}
