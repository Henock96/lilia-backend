import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { brazzavilleClock } from '../vendors/vendor-opening.policy';
import {
  BOOKING_ERROR_CODES,
  ReservationActor,
  ReservationStatus,
  RESERVATION_TIMINGS,
} from './reservation-booking-vocab';
import { canTransition } from './reservation-state.machine';

/**
 * Lot 4 — lecture, projection et transition d'une réservation.
 *
 * - `allowedActions` est le **verdict serveur** (règle 2) : les apps affichent
 *   un bouton si et seulement si l'action y figure. Il combine la machine
 *   d'états et les règles de temps (échéances, fenêtre d'absence) ; il ne
 *   propose que les gestes livrés — ceux qui touchent l'argent (payer, annuler
 *   une réservation payée, arrivée par code) arrivent en 4B-2.
 * - Une transition = `updateMany … WHERE status = <lu>` + contrôle de `count`
 *   (règle 10), et une ligne de journal dans la même transaction.
 */

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

export const RESERVATION_RECORD_SELECT = {
  id: true,
  restaurantId: true,
  userId: true,
  spaceId: true,
  status: true,
  partySize: true,
  arrivalAt: true,
  endsAt: true,
  contactPhone: true,
  note: true,
  responseDeadlineAt: true,
  paymentDeadlineAt: true,
  acceptedAt: true,
  declinedAt: true,
  declineReason: true,
  expiredAt: true,
  cancelledAt: true,
  cancelReason: true,
  confirmedAt: true,
  honoredAt: true,
  noShowAt: true,
  createdAt: true,
  space: { select: { id: true, kind: true, label: true } },
  restaurant: { select: { id: true, nom: true, ownerId: true } },
  user: { select: { id: true, nom: true } },
  items: {
    select: {
      id: true,
      productId: true,
      menuId: true,
      variantId: true,
      quantite: true,
      productName: true,
      variantLabel: true,
      options: { select: { optionId: true, quantity: true } },
    },
    orderBy: { createdAt: 'asc' },
  },
} as const satisfies Prisma.ReservationSelect;

export type ReservationRecord = Prisma.ReservationGetPayload<{
  select: typeof RESERVATION_RECORD_SELECT;
}>;

export type ClientAction = 'cancel';
export type VendorAction =
  | 'accept'
  | 'decline'
  | 'cancel'
  | 'reassign'
  | 'noShow'
  | 'undoNoShow';

const statusOf = (r: Pick<ReservationRecord, 'status'>) =>
  r.status as ReservationStatus;

export function clientAllowedActions(
  r: Pick<ReservationRecord, 'status'>,
): ClientAction[] {
  // 4B-1 : rien n'est encore payé ; l'annulation d'une réservation payée
  // (remboursement ou compensation selon la borne) arrive avec 4B-2.
  const s = statusOf(r);
  return (s === 'PENDING' || s === 'AWAITING_PAYMENT') &&
    canTransition(s, 'CANCELLED_BY_CLIENT', 'CLIENT')
    ? ['cancel']
    : [];
}

/** Fenêtre d'absence (B2) : de l'arrivée + 15 min à la fin du jour d'arrivée. */
export function noShowWindowOpen(arrivalAt: Date, now: Date): boolean {
  const opensAt =
    arrivalAt.getTime() + RESERVATION_TIMINGS.noShowGraceMin * MINUTE_MS;
  if (now.getTime() < opensAt) return false;
  return brazzavilleClock(now).isoDate === brazzavilleClock(arrivalAt).isoDate;
}

/** Le retrait d'une absence reste possible 24 h (B2). */
export function noShowUndoOpen(noShowAt: Date | null, now: Date): boolean {
  return (
    noShowAt !== null &&
    now.getTime() <
      noShowAt.getTime() + RESERVATION_TIMINGS.noShowUndoHours * HOUR_MS
  );
}

export function vendorAllowedActions(
  r: Pick<
    ReservationRecord,
    'status' | 'arrivalAt' | 'responseDeadlineAt' | 'noShowAt'
  >,
  now: Date,
): VendorAction[] {
  const s = statusOf(r);
  const actions: VendorAction[] = [];
  if (s === 'PENDING' && now < r.responseDeadlineAt) {
    actions.push('accept', 'decline');
  }
  // 4B-1 : seule une réservation non payée s'annule ; l'annulation d'une
  // réservation payée (remboursement intégral) arrive avec 4B-2.
  if (s === 'AWAITING_PAYMENT') actions.push('cancel');
  if (
    (s === 'PENDING' || s === 'AWAITING_PAYMENT' || s === 'CONFIRMED') &&
    now < r.arrivalAt
  ) {
    actions.push('reassign');
  }
  if (s === 'CONFIRMED' && noShowWindowOpen(r.arrivalAt, now)) {
    actions.push('noShow');
  }
  if (s === 'NO_SHOW' && noShowUndoOpen(r.noShowAt, now)) {
    actions.push('undoNoShow');
  }
  return actions;
}

function itemsView(r: ReservationRecord) {
  return r.items.map((i) => ({
    productId: i.productId,
    menuId: i.menuId,
    variantId: i.variantId,
    quantite: i.quantite,
    productName: i.productName,
    variantLabel: i.variantLabel,
    options: i.options,
  }));
}

function timelineView(r: ReservationRecord) {
  return {
    createdAt: r.createdAt,
    responseDeadlineAt: r.responseDeadlineAt,
    paymentDeadlineAt: r.paymentDeadlineAt,
    acceptedAt: r.acceptedAt,
    declinedAt: r.declinedAt,
    expiredAt: r.expiredAt,
    cancelledAt: r.cancelledAt,
    confirmedAt: r.confirmedAt,
    honoredAt: r.honoredAt,
    noShowAt: r.noShowAt,
  };
}

/** Ce que voit le client : sa réservation, sa table, aucun détail interne. */
export function toClientView(r: ReservationRecord) {
  return {
    id: r.id,
    status: r.status,
    restaurant: { id: r.restaurant.id, nom: r.restaurant.nom },
    partySize: r.partySize,
    arrivalAt: r.arrivalAt,
    endsAt: r.endsAt,
    // Le nom de sa propre table (C5 : il en est prévenu à la réattribution).
    spaceLabel: r.space.label,
    contactPhone: r.contactPhone,
    note: r.note,
    declineReason: r.declineReason,
    cancelReason: r.cancelReason,
    items: itemsView(r),
    ...timelineView(r),
    allowedActions: clientAllowedActions(r),
  };
}

/** Ce que voit le restaurant : de quoi recevoir et joindre le client. */
export function toVendorView(r: ReservationRecord, now: Date) {
  return {
    id: r.id,
    status: r.status,
    customer: { id: r.user.id, nom: r.user.nom, phone: r.contactPhone },
    partySize: r.partySize,
    arrivalAt: r.arrivalAt,
    endsAt: r.endsAt,
    space: r.space,
    note: r.note,
    declineReason: r.declineReason,
    cancelReason: r.cancelReason,
    items: itemsView(r),
    ...timelineView(r),
    allowedActions: vendorAllowedActions(r, now),
  };
}

export interface TransitionArgs {
  id: string;
  from: ReservationStatus;
  to: ReservationStatus;
  actor: ReservationActor;
  actorId: string | null;
  reason?: string | null;
  data?: Prisma.ReservationUpdateManyMutationInput;
}

/**
 * Transition conditionnelle : 0 ligne ⇒ l'état a changé entre la lecture et
 * l'écriture ⇒ 409, et rien d'autre n'est écrit (la transaction annule tout).
 */
export async function applyTransition(
  tx: Prisma.TransactionClient,
  args: TransitionArgs,
): Promise<void> {
  if (!canTransition(args.from, args.to, args.actor)) {
    throw stateConflict(args.from);
  }
  const { count } = await tx.reservation.updateMany({
    where: { id: args.id, status: args.from },
    data: { ...args.data, status: args.to },
  });
  if (count !== 1) throw stateConflict(args.from);
  await tx.reservationEvent.create({
    data: {
      reservationId: args.id,
      fromStatus: args.from,
      toStatus: args.to,
      actorRole: args.actor,
      actorId: args.actorId,
      reason: args.reason ?? null,
    },
  });
}

export function stateConflict(from?: string): ConflictException {
  return new ConflictException({
    message:
      'Cette réservation a changé entre-temps. Rechargez-la avant d’agir.',
    code: BOOKING_ERROR_CODES.stateConflict,
    ...(from ? { status: from } : {}),
  });
}
