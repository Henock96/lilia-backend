import { ConflictException } from '@nestjs/common';

import {
  BOOKING_ERROR_CODES,
  ReservationActor,
  ReservationStatus,
} from './reservation-booking-vocab';

/**
 * Lot 4 — machine d'états d'une réservation. **Le code est la vérité**
 * (règle 4) : aucune application ne la recopie, elles lisent `allowedActions`.
 *
 * Chaque ligne nomme l'acteur autorisé ; une transition absente est
 * interdite. Décisions : 03-approval §3 du Lot 4.
 *
 *   PENDING ──vendeur──▶ AWAITING_PAYMENT ──paiement──▶ CONFIRMED ──code──▶ HONORED
 *      │                     │                             │
 *      ├─▶ DECLINED          ├─▶ EXPIRED (paiement)        ├─▶ NO_SHOW ⇄ (retrait 24 h)
 *      ├─▶ EXPIRED           ├─▶ CANCELLED_BY_CLIENT        ├─▶ CANCELLED_BY_CLIENT
 *      └─▶ CANCELLED_BY_CLIENT └▶ CANCELLED_BY_VENDOR       └─▶ CANCELLED_BY_VENDOR
 */
export const RESERVATION_TRANSITION_MATRIX: Record<
  ReservationStatus,
  Partial<Record<ReservationStatus, readonly ReservationActor[]>>
> = {
  PENDING: {
    // Le restaurant accepte : la table est tenue, le client doit payer (C4).
    AWAITING_PAYMENT: ['RESTAURATEUR'],
    DECLINED: ['RESTAURATEUR'],
    // Échéance de réponse dépassée (B3).
    EXPIRED: ['SYSTEM'],
    // Rien n'est payé : le client retire sa demande quand il veut.
    CANCELLED_BY_CLIENT: ['CLIENT'],
  },
  AWAITING_PAYMENT: {
    // Seul le prestataire de paiement confirme (règle 3) — 4B-2.
    CONFIRMED: ['SYSTEM'],
    // Délai de paiement dépassé (C4).
    EXPIRED: ['SYSTEM'],
    CANCELLED_BY_CLIENT: ['CLIENT'],
    CANCELLED_BY_VENDOR: ['RESTAURATEUR'],
  },
  CONFIRMED: {
    // Code du client saisi par le vendeur (D2) — 4B-2.
    HONORED: ['RESTAURATEUR'],
    NO_SHOW: ['RESTAURATEUR'],
    // Remboursement ou compensation selon la borne (C3) — 4B-2.
    CANCELLED_BY_CLIENT: ['CLIENT'],
    // Remboursement intégral (C3) — 4B-2.
    CANCELLED_BY_VENDOR: ['RESTAURATEUR'],
  },
  // Retrait d'une absence déclarée par erreur, sous 24 h (B2).
  NO_SHOW: { CONFIRMED: ['RESTAURATEUR'] },
  DECLINED: {},
  EXPIRED: {},
  CANCELLED_BY_CLIENT: {},
  CANCELLED_BY_VENDOR: {},
  HONORED: {},
};

export function canTransition(
  from: ReservationStatus,
  to: ReservationStatus,
  actor: ReservationActor,
): boolean {
  return RESERVATION_TRANSITION_MATRIX[from]?.[to]?.includes(actor) ?? false;
}

/** 409 avec un code stable : l'état a changé, ou le geste n'existe pas. */
export function assertReservationTransition(
  from: ReservationStatus,
  to: ReservationStatus,
  actor: ReservationActor,
): void {
  if (!canTransition(from, to, actor)) {
    throw new ConflictException({
      message:
        'Cette réservation ne permet pas cette action dans son état actuel.',
      code: BOOKING_ERROR_CODES.stateConflict,
      status: from,
    });
  }
}
