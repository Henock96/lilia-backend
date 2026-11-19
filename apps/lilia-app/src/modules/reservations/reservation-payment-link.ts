import { ConflictException } from '@nestjs/common';
import { OrderStatus, Prisma, RefundReasonCode } from '@prisma/client';

import { BOOKING_ERROR_CODES } from './reservation-booking-vocab';

import {
  ORDER_REFUND_DUE_EVENT,
  RESERVATION_NOTICE_EVENT,
} from '../outbox/outbox-events';
import type { ReservationNoticePayload } from './reservation-notices';
import { canTransition } from './reservation-state.machine';

type Db = Prisma.TransactionClient;

/**
 * J6 — la commande liée passe `LIVRER` : sa réservation est honorée dans la
 * même transaction (`OrderTransitionService.tryTransition`). Seule la remise
 * par code y mène (OD-20 ferme les autres chemins). Une réservation qui n'est
 * pas `CONFIRMED` (absence déclarée, annulée) refuse la remise : 409, la
 * transaction entière est annulée, la commande ne bouge pas.
 */
export async function honorLinkedReservation(
  tx: Db,
  reservationId: string,
  actorId: string | null,
  now: Date,
): Promise<void> {
  const { count } = canTransition('CONFIRMED', 'HONORED', 'RESTAURATEUR')
    ? await tx.reservation.updateMany({
        where: { id: reservationId, status: 'CONFIRMED' },
        data: { status: 'HONORED', honoredAt: now },
      })
    : { count: 0 };
  if (count !== 1) {
    throw new ConflictException({
      message:
        'La réservation de cette commande n’est plus confirmée (absence déclarée ou annulation) : la remise est impossible.',
      code: BOOKING_ERROR_CODES.stateConflict,
    });
  }
  await tx.reservationEvent.create({
    data: {
      reservationId,
      fromStatus: 'CONFIRMED',
      toStatus: 'HONORED',
      actorRole: 'RESTAURATEUR',
      actorId,
      reason: 'PICKUP_CODE',
    },
  });
}

/**
 * Lot 4 (4B-2, OD-06) — encaissement confirmé par le prestataire alors que la
 * réservation était déjà expirée ou annulée.
 *
 * La réservation n'est **jamais** réactivée (la table et le stock sont
 * rendus) ; le client est remboursé intégralement sans attendre qu'un humain
 * lise l'incident. Rend l'obligation `order.refund_due` à écrire dans la
 * transaction de l'appelant si la commande est liée à une réservation et
 * close (`ANNULER`), sinon `null` : une commande ordinaire garde le seul
 * incident existant. Le remboursement est ouvert `PENDING` par le chemin
 * commun (`RefundsService.openForCancelledOrder`, idempotent : au plus un
 * remboursement automatique par commande) et exécuté par la file admin.
 */
export async function lateReservationRefundDue(
  tx: Db,
  orderId: string,
): Promise<{
  type: string;
  aggregateId: string;
  payload: Prisma.InputJsonValue;
} | null> {
  const order = await tx.order.findUnique({
    where: { id: orderId },
    select: { status: true, reservationId: true },
  });
  if (!order?.reservationId || order.status !== OrderStatus.ANNULER) {
    return null;
  }
  return {
    type: ORDER_REFUND_DUE_EVENT,
    aggregateId: orderId,
    payload: {
      reason: 'Paiement confirmé après la clôture de la réservation',
      requestedBy: null,
      reasonCode: RefundReasonCode.ORDER_CANCELLED,
    },
  };
}

/**
 * Lot 4 (4B-2) — le paiement de la commande liée confirme la réservation.
 *
 * Appelé par `OrderTransitionService.tryTransition`, **le** point par lequel
 * passe tout chemin vers `PAYER` (webhook pawaPay, interrogation,
 * réconciliation, confirmation manuelle admin), dans sa transaction et sous
 * le verrou de la commande, AVANT l'écriture de la commande.
 *
 * - Règle 3 : `CONFIRMED` n'est écrit que là, donc sur un verdict du
 *   prestataire (ou le geste admin existant), jamais sur un retour d'app.
 * - Rend `false` si la réservation n'attend plus son paiement (expirée,
 *   annulée) : la commande ne doit **pas** passer `PAYER` ; le paiement suit
 *   le chemin « orphelin » existant (incident), rien n'est forcé.
 * - Les avis (client : confirmée ; restaurant : payée) sont écrits dans la
 *   même transaction (règle 11). L'obligation `order.paid` que le paiement
 *   enfile aussi est acquittée sans push pour une commande liée
 *   (`OutboxDispatcherService`) : elle relancerait le restaurant jusqu'à la
 *   préparation, des jours avant l'arrivée.
 */
export async function confirmLinkedReservation(
  tx: Db,
  reservationId: string,
  now: Date,
): Promise<boolean> {
  if (!canTransition('AWAITING_PAYMENT', 'CONFIRMED', 'SYSTEM')) return false;
  const { count } = await tx.reservation.updateMany({
    where: { id: reservationId, status: 'AWAITING_PAYMENT' },
    data: { status: 'CONFIRMED', confirmedAt: now },
  });
  if (count !== 1) return false;
  await tx.reservationEvent.create({
    data: {
      reservationId,
      fromStatus: 'AWAITING_PAYMENT',
      toStatus: 'CONFIRMED',
      actorRole: 'SYSTEM',
      actorId: null,
      reason: 'PAYMENT_CONFIRMED',
    },
  });
  const r = await tx.reservation.findUniqueOrThrow({
    where: { id: reservationId },
    select: {
      userId: true,
      partySize: true,
      arrivalAt: true,
      restaurant: { select: { nom: true, ownerId: true } },
    },
  });
  const common = {
    restaurantName: r.restaurant.nom,
    reservationId,
    arrivalAt: r.arrivalAt.toISOString(),
    partySize: r.partySize,
  };
  const notices: ReservationNoticePayload[] = [
    {
      ...common,
      notice: 'CONFIRMED',
      audience: 'CLIENT',
      recipientUserId: r.userId,
    },
    {
      ...common,
      notice: 'PAID',
      audience: 'VENDOR',
      recipientUserId: r.restaurant.ownerId,
    },
  ];
  for (const payload of notices) {
    await tx.outboxEvent.create({
      data: {
        type: RESERVATION_NOTICE_EVENT,
        aggregateId: reservationId,
        payload: payload as unknown as Prisma.InputJsonValue,
      },
    });
  }
  return true;
}
