import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { brazzavilleClock } from '../vendors/vendor-opening.policy';
import {
  BOOKING_ERROR_CODES,
  CAPACITY_HOLDING_STATUSES,
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
  indicativeSubTotal: true,
  lateCancellation: true,
  createdAt: true,
  // 4B-2 — la commande liée (montant réel, figé à l'acceptation).
  order: {
    select: {
      id: true,
      status: true,
      subTotal: true,
      serviceFee: true,
      total: true,
      paymentDueAt: true,
    },
  },
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
      optionsSignature: true,
      productName: true,
      variantLabel: true,
      indicativeLineTotal: true,
      menuName: true,
      options: {
        select: {
          optionId: true,
          quantity: true,
          optionName: true,
          priceDelta: true,
        },
      },
    },
    orderBy: { createdAt: 'asc' },
  },
} as const satisfies Prisma.ReservationSelect;

export type ReservationRecord = Prisma.ReservationGetPayload<{
  select: typeof RESERVATION_RECORD_SELECT;
}>;

export type ClientAction = 'cancel' | 'pay';
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
  r: Pick<ReservationRecord, 'status' | 'paymentDeadlineAt' | 'arrivalAt'> & {
    order?: { status: string } | null;
  },
  now: Date = new Date(),
): ClientAction[] {
  const s = statusOf(r);
  const actions: ClientAction[] = [];
  // 4B-2 — payer : acceptée, commande liée en attente, échéance non passée.
  if (
    s === 'AWAITING_PAYMENT' &&
    r.order?.status === 'EN_ATTENTE' &&
    r.paymentDeadlineAt !== null &&
    now < r.paymentDeadlineAt
  ) {
    actions.push('pay');
  }
  // J5 — payée, elle s'annule jusqu'à l'heure d'arrivée (remboursée, même
  // tardive, en V1) ; ensuite c'est l'arrivée ou l'absence qui la conclut.
  if (
    (s === 'PENDING' ||
      s === 'AWAITING_PAYMENT' ||
      (s === 'CONFIRMED' && now < r.arrivalAt)) &&
    canTransition(s, 'CANCELLED_BY_CLIENT', 'CLIENT')
  ) {
    actions.push('cancel');
  }
  return actions;
}

/**
 * J5 (C2) — annulation « tardive » : l'arrivée est à moins de
 * `cancelCutoffMin` (120 min). Elle ne change pas le remboursement en V1
 * (OD-08 option E) ; elle est enregistrée (`lateCancellation`).
 */
export function isLateCancellation(arrivalAt: Date, now: Date): boolean {
  return (
    arrivalAt.getTime() - now.getTime() <
    RESERVATION_TIMINGS.cancelCutoffMin * MINUTE_MS
  );
}

/**
 * J5 — la politique d'annulation, verdict serveur affiché avant de payer
 * (« annulation gratuite jusqu'à HH:MM ») : `freeUntil` = arrivée − 120 min.
 * `refundable` est vrai pour toute réservation payée en V1 (OD-08 option E) ;
 * il portera la retenue quand elle existera (OD-22). `null` sans commande.
 */
function cancellationPolicyView(r: ReservationRecord) {
  if (!r.order) return null;
  return {
    freeUntil: new Date(
      r.arrivalAt.getTime() - RESERVATION_TIMINGS.cancelCutoffMin * MINUTE_MS,
    ),
    refundable: true,
    lateCancellation: r.lateCancellation,
    // J6 (option D, 19/11) — une absence n'est pas remboursée ; le client le
    // voit avant de payer.
    noShowRefundable: false,
  };
}

/** Fenêtre d'absence (B2) : de l'arrivée + 15 min à la fin du jour d'arrivée. */
export function noShowWindowOpen(arrivalAt: Date, now: Date): boolean {
  const opensAt =
    arrivalAt.getTime() + RESERVATION_TIMINGS.noShowGraceMin * MINUTE_MS;
  if (now.getTime() < opensAt) return false;
  return brazzavilleClock(now).isoDate === brazzavilleClock(arrivalAt).isoDate;
}

/** Le retrait d'une absence reste possible 6 h (B2, révisé le 19/11). */
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
  // J5 — payée, elle s'annule aussi (remboursement intégral, faute du
  // restaurant), tant que rien n'a été remis (la commande le vérifie).
  if (s === 'AWAITING_PAYMENT' || s === 'CONFIRMED') actions.push('cancel');
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
    menuName: i.menuName,
    // P-04 — part indicative de la ligne, figée à la demande (jamais facturée).
    indicativeLineTotal: i.indicativeLineTotal,
    options: i.options,
  }));
}

/**
 * 4B-2 — ce que la précommande coûte : le montant **réel**, figé sur la
 * commande liée à l'acceptation, et l'indicatif de la demande. Un écart n'est
 * jamais silencieux (OD-04) : `priceChanged` le signale, les deux montants
 * sont rendus. `null` tant que le restaurant n'a pas accepté.
 */
function paymentView(r: ReservationRecord) {
  if (!r.order) return null;
  return {
    orderId: r.order.id,
    orderStatus: r.order.status,
    subTotal: r.order.subTotal,
    serviceFee: r.order.serviceFee,
    total: r.order.total,
    indicativeSubTotal: r.indicativeSubTotal,
    priceChanged:
      r.indicativeSubTotal !== null &&
      r.indicativeSubTotal !== r.order.subTotal,
  };
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
export function toClientView(r: ReservationRecord, now: Date = new Date()) {
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
    payment: paymentView(r),
    cancellationPolicy: cancellationPolicyView(r),
    ...timelineView(r),
    allowedActions: clientAllowedActions(r, now),
  };
}

/** R-TEL (16/11) — durée pendant laquelle le restaurant garde le contact. */
export const CUSTOMER_CONTACT_RETENTION_DAYS = 30;

/**
 * R-TEL — le restaurant voit le nom et le numéro du client tant que la
 * réservation vit, puis 30 jours après son issue ; jamais pour une demande
 * refusée ou expirée (il n'a pas reçu ce client).
 */
export function customerContactVisible(
  r: Pick<
    ReservationRecord,
    'status' | 'cancelledAt' | 'honoredAt' | 'noShowAt'
  >,
  now: Date,
): boolean {
  const s = statusOf(r);
  if (s === 'DECLINED' || s === 'EXPIRED') return false;
  if (CAPACITY_HOLDING_STATUSES.includes(s)) return true;
  const endedAt = r.cancelledAt ?? r.honoredAt ?? r.noShowAt;
  if (!endedAt) return true;
  return (
    now.getTime() <
    endedAt.getTime() + CUSTOMER_CONTACT_RETENTION_DAYS * 24 * HOUR_MS
  );
}

/** Ce que voit le restaurant : de quoi recevoir et joindre le client. */
export function toVendorView(r: ReservationRecord, now: Date) {
  const visible = customerContactVisible(r, now);
  return {
    id: r.id,
    status: r.status,
    customer: {
      id: visible ? r.user.id : null,
      nom: visible ? r.user.nom : null,
      phone: visible ? r.contactPhone : null,
    },
    partySize: r.partySize,
    arrivalAt: r.arrivalAt,
    endsAt: r.endsAt,
    space: r.space,
    note: r.note,
    declineReason: r.declineReason,
    cancelReason: r.cancelReason,
    items: itemsView(r),
    payment: paymentView(r),
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
