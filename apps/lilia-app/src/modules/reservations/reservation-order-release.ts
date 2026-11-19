import { ConflictException, Injectable } from '@nestjs/common';
import { OrderStatus, Prisma, RefundReasonCode } from '@prisma/client';

import { OrderTransitionService } from '../orders/order-transition.service';
import { ORDER_REFUND_DUE_EVENT } from '../outbox/outbox-events';
import {
  OrderTransitionActor,
  OrderTransitionSource,
} from '../orders/order-transition.types';
import { StockService } from '../orders/stock.service';
import {
  BOOKING_ERROR_CODES as CODES,
  RESERVATION_TIMINGS,
} from './reservation-booking-vocab';
import { stateConflict } from './reservation-records';

type Db = Prisma.TransactionClient;

const MINUTE_MS = 60_000;

/** La commande liée d'une réservation non payée, verrouillée. */
export interface LockedLinkedOrder {
  id: string;
  createdAt: Date;
  /** Création de la tentative de paiement en cours, `null` s'il n'y en a pas. */
  pendingPaymentSince: Date | null;
}

/** La commande liée d'une réservation payée, verrouillée. */
export interface LockedPaidOrder {
  id: string;
  status: OrderStatus;
  createdAt: Date;
  /** Montant encaissé (XAF) : celui du remboursement intégral annoncé. */
  total: number;
}

/**
 * J5 — états d'une commande liée payée dont la réservation s'annule encore :
 * payée, acceptée, en préparation ou prête — rien n'a été remis.
 */
const PAID_CANCELLABLE: readonly OrderStatus[] = [
  'PAYER',
  'ACCEPTEE',
  'EN_PREPARATION',
  'PRET',
];

/**
 * Lot 4 (4B-2) — libère la commande liée d'une réservation `AWAITING_PAYMENT`
 * qui expire ou est annulée : commande `EN_ATTENTE → ANNULER`, stock rendu
 * (ce que l'acceptation a réellement pris), tentative `PENDING` close — dans
 * la transaction de la réservation. Invariant : commande liée `EN_ATTENTE` ⇔
 * réservation `AWAITING_PAYMENT`.
 *
 * **Ordre des verrous : la commande, puis la réservation.** C'est l'ordre de
 * la confirmation d'un paiement (paiement → commande → réservation) ; le
 * prendre à l'envers ici ferait un interblocage avec un webhook simultané.
 *
 * Sans dépendance HTTP : utilisé par l'API (annulations) et par le worker
 * (expiration).
 */
@Injectable()
export class ReservationOrderRelease {
  constructor(
    private readonly transitions: OrderTransitionService,
    private readonly stock: StockService,
  ) {}

  /**
   * À appeler **avant** toute écriture de la réservation. Verrouille la
   * commande (`FOR UPDATE`, qui retient aussi l'insertion d'une tentative de
   * paiement concurrente) et la rend, ou `null` pour une réservation sans
   * commande liée (demande non acceptée, ou antérieure à 4B-2). Une commande
   * qui n'est plus `EN_ATTENTE` — payée à l'instant — lève 409 : la
   * réservation va être confirmée, elle ne s'annule ni n'expire.
   */
  async lock(tx: Db, reservationId: string): Promise<LockedLinkedOrder | null> {
    // Revue base du 18/11 — ordre des verrous de la confirmation d'un
    // paiement : PAIEMENT, puis commande. `release` réécrit les tentatives
    // PENDING ; les verrouiller après la commande ferait un interblocage avec
    // un webhook simultané (qui tient le paiement et attend la commande).
    await tx.$queryRaw`
      SELECT p."id" FROM "payments" p
        JOIN "Order" o ON o."id" = p."orderId"
       WHERE o."reservationId" = ${reservationId} AND p."status" = 'PENDING'
         FOR UPDATE OF p`;
    const rows = await tx.$queryRaw<
      { id: string; status: string; createdAt: Date }[]
    >`SELECT "id", "status", "createdAt" FROM "Order"
       WHERE "reservationId" = ${reservationId} FOR UPDATE`;
    if (rows.length === 0) return null;
    const order = rows[0];
    if (order.status !== 'EN_ATTENTE') throw stateConflict('AWAITING_PAYMENT');
    const pending = await tx.payment.findFirst({
      where: { orderId: order.id, status: 'PENDING' },
      select: { createdAt: true },
      orderBy: { createdAt: 'desc' },
    });
    return {
      id: order.id,
      createdAt: order.createdAt,
      pendingPaymentSince: pending?.createdAt ?? null,
    };
  }

  /**
   * Un geste humain (client, restaurant) ne coupe pas un paiement en cours :
   * le prestataire tranche en quelques minutes, et annuler maintenant
   * fabriquerait un débit sur une commande annulée.
   */
  assertNoPaymentInProgress(order: LockedLinkedOrder | null): void {
    if (order?.pendingPaymentSince) {
      throw new ConflictException({
        message:
          'Un paiement est en cours pour cette réservation. Attendez sa confirmation ou son échec (quelques minutes) avant d’annuler.',
        code: CODES.paymentInProgress,
      });
    }
  }

  /**
   * OD-05 — délai de grâce : une tentative en cours garde la réservation au
   * plus `tentative + 17 min` (abandon de la réconciliation + un tour), et
   * jamais après l'arrivée.
   */
  inGrace(
    order: LockedLinkedOrder | null,
    arrivalAt: Date,
    now: Date,
  ): boolean {
    if (!order?.pendingPaymentSince || now >= arrivalAt) return false;
    return (
      now.getTime() <
      order.pendingPaymentSince.getTime() +
        RESERVATION_TIMINGS.paymentGraceMin * MINUTE_MS
    );
  }

  /**
   * J5 — la commande liée d'une réservation **payée** (`CONFIRMED`),
   * verrouillée avant la réservation (même ordre que `lock`). 409 si elle
   * n'est plus annulable : remise au client (`LIVRER`, J6) ou déjà close.
   * Une réservation confirmée a toujours sa commande (seul le paiement de
   * celle-ci la confirme).
   */
  async lockPaid(tx: Db, reservationId: string): Promise<LockedPaidOrder> {
    const rows = await tx.$queryRaw<LockedPaidOrder[]>`
      SELECT "id", "status", "createdAt", "total" FROM "Order"
       WHERE "reservationId" = ${reservationId} FOR UPDATE`;
    const order = rows[0];
    if (!order || !PAID_CANCELLABLE.includes(order.status)) {
      throw stateConflict('CONFIRMED');
    }
    return order;
  }

  /**
   * J5 — annule la commande payée d'une réservation annulée : `→ ANNULER`,
   * stock rendu, et rend l'obligation `order.refund_due` (remboursement
   * **intégral**, frais compris — OD-07, OD-08 option E) que l'appelant écrit
   * dans la même transaction. Le chemin du remboursement est celui de toute
   * commande annulée après paiement : `Refund PENDING` exécuté par la file
   * admin, ou sans geste humain pour une faute du restaurant
   * (`vendorFault`, `autoRefundVendorFault`).
   *
   * Le client n'a pas le droit d'annuler une commande payée (fix H5) : son
   * annulation de réservation est inscrite `SYSTEM` à l'historique de la
   * commande, avec le motif ; c'est la réservation qui porte son geste.
   */
  async cancelPaid(
    tx: Db,
    order: LockedPaidOrder,
    p: {
      actor: OrderTransitionActor;
      actorUserId: string | null;
      reason: string;
      requestedBy: string;
      vendorFault: boolean;
      /** `ADMIN_APP` pour le support ; `APP` par défaut. */
      source?: OrderTransitionSource;
    },
  ): Promise<{
    type: string;
    aggregateId: string;
    payload: Prisma.InputJsonValue;
  }> {
    const { moved } = await this.transitions.tryTransition(tx, {
      orderId: order.id,
      from: order.status,
      to: 'ANNULER',
      actor: p.actor,
      actorUserId: p.actorUserId,
      source: p.source ?? 'APP',
      reason: p.reason,
    });
    // Impossible sous le verrou pris par `lockPaid`.
    if (!moved) throw stateConflict('CONFIRMED');
    await this.restoreStock(tx, order);
    return {
      type: ORDER_REFUND_DUE_EVENT,
      aggregateId: order.id,
      payload: {
        reason: p.reason,
        requestedBy: p.requestedBy,
        ...(p.vendorFault
          ? { vendorFault: true, reasonCode: RefundReasonCode.VENDOR_REJECTED }
          : { reasonCode: RefundReasonCode.ORDER_CANCELLED }),
      },
    };
  }

  /**
   * J6 (option D) — clôture de la commande d'une absence, 12 h après sa
   * déclaration : `→ ANNULER` (`SYSTEM`, `CRON`), **sans** remboursement dû —
   * l'encaissement est partagé (`ReservationNoShowSettlement`, écrite par
   * l'appelant dans la même transaction) — et **sans** stock rendu : les plats
   * ont été préparés, et le quota du jour d'arrivée est passé.
   */
  async closeForfeited(tx: Db, order: LockedPaidOrder): Promise<void> {
    const { moved } = await this.transitions.tryTransition(tx, {
      orderId: order.id,
      from: order.status,
      to: 'ANNULER',
      actor: 'SYSTEM',
      actorUserId: null,
      source: 'CRON',
      reason: 'Absence du client : encaissement retenu et partagé',
    });
    // Impossible sous le verrou pris par `lockPaid`.
    if (!moved) throw stateConflict('NO_SHOW');
  }

  private async restoreStock(
    tx: Db,
    order: { id: string; createdAt: Date },
  ): Promise<void> {
    const items = await tx.orderItem.findMany({
      where: { orderId: order.id },
      select: { productId: true, quantite: true, stockUnitsReserved: true },
    });
    await this.stock.restoreInTransaction(tx, items, {
      orderCreatedAt: order.createdAt,
    });
  }

  /** Annule la commande verrouillée, rend le stock, clôt la tentative. */
  async release(
    tx: Db,
    order: LockedLinkedOrder,
    p: {
      actor: OrderTransitionActor;
      actorUserId: string | null;
      source: OrderTransitionSource;
      reason: string;
    },
  ): Promise<void> {
    const { moved } = await this.transitions.tryTransition(tx, {
      orderId: order.id,
      from: 'EN_ATTENTE',
      to: 'ANNULER',
      actor: p.actor,
      actorUserId: p.actorUserId,
      source: p.source,
      reason: p.reason,
    });
    // Impossible sous le verrou pris par `lock` : un invariant est rompu.
    if (!moved) throw stateConflict('AWAITING_PAYMENT');
    await this.restoreStock(tx, order);
    // Comme `expireUnpaidOrder` (fix H2) : une tentative PENDING ne survit
    // pas à la commande ; un SUCCESS tardif suivra le chemin « ressuscité »
    // (incident CRITICAL et remboursement automatique, OD-06).
    await tx.payment.updateMany({
      where: { orderId: order.id, status: 'PENDING' },
      data: { status: 'CANCELLED', updatedAt: new Date() },
    });
  }
}
