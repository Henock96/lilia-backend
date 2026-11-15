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
  DeliveryHandoverMethod,
  DeliveryStatus,
  OrderStatus,
  Prisma,
} from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { CLEARED_DRIVER_ECONOMICS } from '../deliveries/delivery-assignment.service';
import { DeliveryAssignmentLogService } from '../deliveries/delivery-assignment-log.service';
import { releaseDriverIfIdle } from '../drivers/driver-release';
import { DeliveryUnassignedEvent } from '../events/delivery-events';
import { OrderStatusUpdatedEvent } from '../events/order-events';
import { ORDER_VOUCHER_ISSUED_EVENT } from '../outbox/outbox-events';
import { OutboxService } from '../outbox/outbox.service';
import { createNominativeVoucher } from '../promo/voucher';
import { COUNTED_REFUND_STATUSES } from '../refunds/refund-lines.policy';
import {
  DELIVERY_ARBITRABLE_STATUSES,
  DELIVERY_ARBITRATION_LABELS,
  DeliveryArbitration,
} from './delivery-arbitration';
import { lockOrderRow } from './order-row-lock';
import { OrderStateMachine } from './order-state.machine';
import { OrderTransitionService } from './order-transition.service';

/** Même validité par défaut que l'avoir d'une réclamation (R-06.6). */
export const ARBITRATION_VOUCHER_DEFAULT_DAYS = 30;

const TERMINAL_DELIVERY_STATUSES: DeliveryStatus[] = [
  DeliveryStatus.LIVRER,
  DeliveryStatus.ECHEC,
];

export interface DeliveryArbitrationResult {
  id: string;
  status: OrderStatus;
  deliveryProof: string | null;
  voucher: { code: string; amountXaf: number; expiresAt: Date } | null;
}

/**
 * Arbitrage de livraison (retours produit du 15/11/2026, D1) — voir
 * `delivery-arbitration.ts` pour la règle métier.
 *
 * Tout est écrit dans UNE transaction : les deux transitions, la course, le
 * journal d'audit, l'avoir et l'obligation de prévenir le client. Une
 * transition perdue (commande qui a bougé) annule l'ensemble — c'est aussi ce
 * qui rend le geste non rejouable : la seconde requête trouve `LIVRER` et
 * n'émet aucun second avoir.
 *
 * Ce que le geste NE fait PAS, délibérément :
 *  - aucun remboursement : le client a refusé, ou a été livré hors application ;
 *  - ni fidélité ni parrainage : pas d'`ORDER_DELIVERED_EVENT` (D1.c) ;
 *  - un livreur qui n'a pas récupéré le repas n'est pas payé : sa course est
 *    fermée comme à l'annulation. Celui qui l'a en main (`EN_TRANSIT`) termine
 *    sa course, et sa rémunération suit la règle habituelle.
 */
@Injectable()
export class DeliveryArbitrationService {
  private readonly logger = new Logger(DeliveryArbitrationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stateMachine: OrderStateMachine,
    private readonly transitions: OrderTransitionService,
    private readonly assignmentLog: DeliveryAssignmentLogService,
    private readonly outbox: OutboxService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async arbitrate(
    orderId: string,
    firebaseUid: string,
    arbitration: DeliveryArbitration,
  ): Promise<DeliveryArbitrationResult> {
    const admin = await this.prisma.user.findUnique({
      where: { firebaseUid },
      select: { id: true, role: true },
    });
    if (!admin) throw new NotFoundException('Utilisateur non trouvé.');
    if (admin.role !== 'ADMIN') {
      throw new ForbiddenException(
        'Seul un administrateur clôture une livraison.',
      );
    }

    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        status: true,
        isDelivery: true,
        userId: true,
        restaurantId: true,
        total: true,
        restaurant: { select: { nom: true } },
      },
    });
    if (!order) throw new NotFoundException('Commande non trouvée.');
    if (!order.isDelivery) {
      throw new ConflictException({
        message: 'Un retrait se clôture par « Arbitrer la remise », pas ici.',
        code: 'DELIVERY_ARBITRATION_NOT_APPLICABLE',
      });
    }
    if (!DELIVERY_ARBITRABLE_STATUSES.includes(order.status)) {
      throw new ConflictException({
        message:
          'Seule une livraison prête ou en route peut être clôturée par l’administration.',
        code: 'DELIVERY_ARBITRATION_NOT_APPLICABLE',
      });
    }
    const voucherAmount = arbitration.voucherAmountXaf;

    // La matrice reste l'autorité (règle 4) : si elle retirait un jour ces
    // droits à l'ADMIN, le geste cesserait de fonctionner, bruyamment.
    if (order.status === OrderStatus.PRET) {
      this.stateMachine.assertTransition('PRET', 'EN_ROUTE', 'ADMIN');
    }
    this.stateMachine.assertTransition('EN_ROUTE', 'LIVRER', 'ADMIN');

    const label = DELIVERY_ARBITRATION_LABELS[arbitration.reason];
    const historyReason =
      `Arbitrage livraison : ${label}` +
      (arbitration.note ? ` — ${arbitration.note}` : '');
    const now = new Date();
    const expiresAt =
      voucherAmount !== undefined
        ? new Date(
            now.getTime() +
              (arbitration.voucherExpiresInDays ??
                ARBITRATION_VOUCHER_DEFAULT_DAYS) *
                86_400_000,
          )
        : null;

    const outcome = await this.prisma.$transaction(
      async (
        tx,
      ): Promise<{
        deliveryProof: string | null;
        voucher: { id: string; code: string } | null;
        releasedDriver: { deliveryId: string; delivererId: string } | null;
      }> => {
        // Rang R1 de l'ordre global des verrous, avant toute écriture.
        await lockOrderRow(tx, orderId);

        // Plafond de l'avoir, lu sous le verrou : ce que le client a payé,
        // moins ce qui lui est déjà rendu ou promis en remboursement (lignes
        // comptées, comme F3-05). Un avoir ne rend jamais plus que l'argent
        // encore engagé sur la commande.
        if (voucherAmount !== undefined) {
          const refunded = await tx.refund.aggregate({
            where: { orderId, status: { in: COUNTED_REFUND_STATUSES } },
            _sum: { amount: true },
          });
          const ceiling = Math.max(
            0,
            order.total - (refunded._sum.amount ?? 0),
          );
          if (voucherAmount > ceiling) {
            throw new BadRequestException({
              message: `L’avoir ne peut pas dépasser ce que le client a payé, remboursements déduits (${ceiling} FCFA).`,
              code: 'VOUCHER_EXCEEDS_TOTAL',
            });
          }
        }

        const base = {
          orderId,
          actor: 'ADMIN' as const,
          actorUserId: admin.id,
          source: 'ADMIN_APP' as const,
          reason: historyReason,
        };
        let from: OrderStatus = order.status;
        if (from === OrderStatus.PRET) {
          await this.transitions.transition(tx, {
            ...base,
            from,
            to: OrderStatus.EN_ROUTE,
          });
          from = OrderStatus.EN_ROUTE;
        }
        await this.transitions.transition(tx, {
          ...base,
          from,
          to: OrderStatus.LIVRER,
          proof: 'DELIVERY_ADMIN_OVERRIDE',
        });

        const delivery = await this.closeDelivery(tx, orderId, now);

        const voucher =
          voucherAmount !== undefined && expiresAt
            ? await createNominativeVoucher(tx, {
                userId: order.userId,
                amountXaf: voucherAmount,
                expiresAt,
                description: `Avoir — livraison clôturée, commande #${orderId.slice(-8).toUpperCase()}`,
              }).catch((error: unknown) => {
                // Seule unicité possible ici : le code tiré (31⁸ valeurs).
                // Traduite à la source, pour ne pas prêter ce message à une
                // autre contrainte de la transaction.
                if (
                  error instanceof Prisma.PrismaClientKnownRequestError &&
                  error.code === 'P2002'
                ) {
                  throw new ConflictException(
                    'Code d’avoir déjà pris : réessayez.',
                  );
                }
                throw error;
              })
            : null;
        if (voucher) {
          await this.outbox.enqueueInTransaction(tx, {
            type: ORDER_VOUCHER_ISSUED_EVENT,
            aggregateId: orderId,
            payload: { promoCodeId: voucher.id },
          });
        }

        await tx.adminAuditLog.create({
          data: {
            actorId: admin.id,
            action: AdminAuditAction.ORDER_STATUS_FORCED,
            targetType: 'Order',
            targetId: orderId,
            reason: arbitration.reason,
            metadata: {
              from: order.status,
              to: OrderStatus.LIVRER,
              kind: 'DELIVERY_ARBITRATION',
              reason: arbitration.reason,
              ...(arbitration.note ? { note: arbitration.note } : {}),
              delivery: delivery
                ? {
                    id: delivery.id,
                    from: delivery.from,
                    to: delivery.to,
                  }
                : null,
              voucher: voucher
                ? {
                    // Pas le code : il vaut paiement pour son bénéficiaire.
                    promoCodeId: voucher.id,
                    amountXaf: voucherAmount,
                    expiresAt: expiresAt!.toISOString(),
                  }
                : null,
            },
          },
        });

        const closed = await tx.order.findUniqueOrThrow({
          where: { id: orderId },
          select: { deliveryProof: true },
        });
        return {
          deliveryProof: closed.deliveryProof,
          voucher,
          releasedDriver:
            delivery?.to === DeliveryStatus.ECHEC && delivery.delivererId
              ? { deliveryId: delivery.id, delivererId: delivery.delivererId }
              : null,
        };
      },
    );

    this.logger.log(
      `[ARBITRAGE] livraison ${orderId} clôturée par ${admin.id} (${arbitration.reason})` +
        (outcome.voucher ? `, avoir ${voucherAmount} FCFA` : ''),
    );

    // Après le commit : temps réel et notifications, comme toute clôture.
    this.eventEmitter.emit(
      'order.status.updated',
      new OrderStatusUpdatedEvent(
        orderId,
        order.userId,
        order.restaurantId,
        order.status,
        OrderStatus.LIVRER,
        admin.id,
        { restaurantName: order.restaurant.nom, totalAmount: order.total },
        undefined,
        'DELIVERY_ARBITRATION',
      ),
    );
    if (outcome.releasedDriver) {
      this.eventEmitter.emit(
        'delivery.unassigned',
        new DeliveryUnassignedEvent(
          outcome.releasedDriver.deliveryId,
          orderId,
          order.restaurantId,
          outcome.releasedDriver.delivererId,
          'order_closed_by_admin',
          historyReason,
        ),
      );
    }

    return {
      id: orderId,
      status: OrderStatus.LIVRER,
      deliveryProof: outcome.deliveryProof,
      voucher:
        outcome.voucher && expiresAt
          ? {
              code: outcome.voucher.code,
              amountXaf: voucherAmount!,
              expiresAt,
            }
          : null,
    };
  }

  /**
   * Ferme la course de la commande, s'il y en a une encore ouverte.
   *
   *  - `EN_TRANSIT` : le livreur a le repas, la course s'achève comme une
   *    clôture ADMIN de la livraison (`ADMIN_OVERRIDE`, main `COMPLETED`).
   *  - avant la récupération : aucune course n'a eu lieu — fermée comme à
   *    l'annulation (`ECHEC`, livreur détaché, économie effacée).
   *
   * Verrou optimiste sur l'état lu, sous le verrou de la commande (R1 → R2),
   * puis libération du livreur s'il ne porte plus rien (R4).
   */
  private async closeDelivery(
    tx: Prisma.TransactionClient,
    orderId: string,
    now: Date,
  ): Promise<{
    id: string;
    from: DeliveryStatus;
    to: DeliveryStatus;
    delivererId: string | null;
  } | null> {
    const delivery = await tx.delivery.findUnique({
      where: { orderId },
      select: { id: true, status: true, delivererId: true },
    });
    if (!delivery || TERMINAL_DELIVERY_STATUSES.includes(delivery.status)) {
      return null;
    }

    const carried = delivery.status === DeliveryStatus.EN_TRANSIT;
    const to = carried ? DeliveryStatus.LIVRER : DeliveryStatus.ECHEC;
    const claimed = await tx.delivery.updateMany({
      where: { id: delivery.id, status: delivery.status },
      data: carried
        ? {
            status: to,
            deliveredAt: now,
            handoverMethod: DeliveryHandoverMethod.ADMIN_OVERRIDE,
            handoverVerifiedAt: null,
          }
        : { status: to, delivererId: null, ...CLEARED_DRIVER_ECONOMICS },
    });
    if (claimed.count === 0) {
      throw new ConflictException(
        'La course de cette commande a changé d’état entre-temps. Rechargez-la avant de réessayer.',
      );
    }

    await this.assignmentLog.close(
      tx,
      delivery.id,
      carried
        ? DeliveryAssignmentOutcome.COMPLETED
        : DeliveryAssignmentOutcome.ORDER_CANCELLED,
      'Commande clôturée par l’administration',
      now,
    );
    if (delivery.delivererId) {
      await releaseDriverIfIdle(tx, delivery.delivererId);
    }

    return {
      id: delivery.id,
      from: delivery.status,
      to,
      delivererId: delivery.delivererId,
    };
  }
}
