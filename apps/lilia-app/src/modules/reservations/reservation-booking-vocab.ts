/**
 * Lot 4 — vocabulaire des réservations client.
 *
 * Miroirs exacts des CHECK de la migration `20261116090000_reservations`
 * (règle 14 : TEXT + CHECK + liste TypeScript). Décisions :
 * `lilia-engineering/features/2026-10-17-reservations-parcours-client/
 * 03-approval.md`.
 *
 * Les applications ne recopient ni ces listes ni la machine d'états : elles
 * lisent `allowedActions` sur chaque réservation (règle 2).
 */
export const RESERVATION_STATUSES = [
  'PENDING',
  'AWAITING_PAYMENT',
  'CONFIRMED',
  'DECLINED',
  'EXPIRED',
  'CANCELLED_BY_CLIENT',
  'CANCELLED_BY_VENDOR',
  'HONORED',
  'NO_SHOW',
] as const;
export type ReservationStatus = (typeof RESERVATION_STATUSES)[number];

/** Statuts qui tiennent la capacité d'une ressource (03 §3). */
export const CAPACITY_HOLDING_STATUSES: readonly ReservationStatus[] = [
  'PENDING',
  'AWAITING_PAYMENT',
  'CONFIRMED',
];

/** Motifs de refus d'une demande (liste fermée). */
export const RESERVATION_DECLINE_REASONS = [
  'FULLY_BOOKED',
  'CLOSED',
  'ITEMS_UNAVAILABLE',
  'PARTY_TOO_LARGE',
  'OTHER',
] as const;
export type ReservationDeclineReason =
  (typeof RESERVATION_DECLINE_REASONS)[number];

/** Motifs d'annulation par le restaurant (liste fermée). */
export const RESERVATION_VENDOR_CANCEL_REASONS = [
  'CLOSED_UNEXPECTEDLY',
  'ITEMS_UNAVAILABLE',
  'OVERBOOKED',
  'CLIENT_REQUEST',
  'OTHER',
] as const;
export type ReservationVendorCancelReason =
  (typeof RESERVATION_VENDOR_CANCEL_REASONS)[number];

export const RESERVATION_ACTORS = [
  'CLIENT',
  'RESTAURATEUR',
  'SYSTEM',
  'ADMIN',
] as const;
export type ReservationActor = (typeof RESERVATION_ACTORS)[number];

/**
 * Délais décidés (03 §2). Constantes nommées et testées ; les deux réglages
 * qui touchent l'argent (borne d'annulation, compensation) arrivent en 4B-2
 * dans `PlatformSettings` (réglages financiers R-09).
 */
export const RESERVATION_TIMINGS = {
  /** B3 — le vendeur répond dans les 30 min (bornées par l'arrivée). */
  vendorResponseMin: 30,
  /** C4 — le client paie dans les 15 min après acceptation (bornées par l'arrivée). */
  paymentWindowMin: 15,
  /** B2 — une absence se déclare au plus tôt 15 min après l'heure d'arrivée. */
  noShowGraceMin: 15,
  /** B2 — le vendeur peut retirer une absence pendant 24 h. */
  noShowUndoHours: 24,
  /** B7 — rappel client 2 h avant l'arrivée… */
  reminderBeforeMin: 120,
  /** …sauf si la réservation a été confirmée moins de 3 h avant. */
  reminderMinConfirmedBeforeMin: 180,
  /** OD-02 — la réponse du vendeur tombe au plus tard 30 min avant l'arrivée… */
  responseBeforeArrivalMin: 30,
  /** …et le paiement au plus tard 10 min avant. */
  paymentBeforeArrivalMin: 10,
  /**
   * OD-02 — aucune arrivée proposée à moins de 60 min, quel que soit le
   * `minLeadMin` du restaurant (Lot 3, min 30) : sinon les deux bornes
   * ci-dessus ne laissent plus le temps de répondre ni de payer.
   */
  minEffectiveLeadMin: 60,
  /**
   * 4B-2 (OD-05) — une tentative de paiement en cours retient l'expiration au
   * plus 17 min (abandon de la réconciliation à 15 min + un tour de cron).
   */
  paymentGraceMin: 17,
  /**
   * 4B-2 (C2, I-02) — annulation client gratuite si l'arrivée est à 120 min
   * ou plus. En deçà, l'annulation est « tardive » (`lateCancellation`) ;
   * en V1 (OD-08 option E) elle est remboursée quand même : la borne ne
   * déplace aucun argent, d'où une constante et non un réglage financier.
   */
  cancelCutoffMin: 120,
} as const;

/**
 * OD-01 — plafonds de demandes actives d'un client, contrôlés sous un verrou
 * par client. Une place se libère à toute sortie terminale, ou quand l'heure
 * d'arrivée d'une réservation confirmée est passée.
 */
export const RESERVATION_ACTIVE_LIMITS = {
  /** `PENDING` + `AWAITING_PAYMENT`, toute la plateforme. */
  unpaid: 2,
  /** `CONFIRMED` dont l'arrivée est à venir. */
  upcomingConfirmed: 3,
  /** `PENDING` + `AWAITING_PAYMENT` + `CONFIRMED`, même restaurant, même jour. */
  perRestaurantPerDay: 1,
} as const;
export type ReservationActiveLimit = keyof typeof RESERVATION_ACTIVE_LIMITS;

/**
 * P-06 — limites de débit des gestes, en plus du throttle global : un geste
 * vendeur 5/s et 60/min, une annulation client 1/s et 10/min.
 */
export const RESERVATION_THROTTLES = {
  vendorGesture: {
    short: { limit: 5, ttl: 1000 },
    long: { limit: 60, ttl: 60_000 },
  },
  clientCancel: {
    short: { limit: 1, ttl: 1000 },
    long: { limit: 10, ttl: 60_000 },
  },
} as const;

/**
 * B2 — 3 absences en 90 jours ferment la réservation 30 jours ; R-ABS
 * (16/11) : seulement si elles viennent d'au moins 2 restaurants.
 */
export const NO_SHOW_RESTRICTION = {
  threshold: 3,
  windowDays: 90,
  restrictionDays: 30,
  minDistinctRestaurants: 2,
} as const;

/**
 * R-SPAM (16/11) — demandes **créées** par un client sur 24 h glissantes,
 * tous statuts confondus (une demande annulée compte) : 6 en tout, 2 par
 * restaurant. Contrôlé sous le verrou client, comme les plafonds OD-01.
 */
export const RESERVATION_CREATION_LIMITS = {
  windowHours: 24,
  total: 6,
  perRestaurant: 2,
} as const;

/** Codes d'erreur HTTP stables, lus par les apps (`error.code`). */
export const BOOKING_ERROR_CODES = {
  notBookable: 'RESERVATION_NOT_BOOKABLE',
  slotUnavailable: 'RESERVATION_SLOT_UNAVAILABLE',
  restricted: 'RESERVATION_RESTRICTED',
  stateConflict: 'RESERVATION_STATE_CONFLICT',
  actionUnavailable: 'RESERVATION_ACTION_UNAVAILABLE',
  cartEmpty: 'RESERVATION_CART_EMPTY',
  cartOtherVendor: 'RESERVATION_CART_OTHER_VENDOR',
  cartChanged: 'RESERVATION_CART_CHANGED',
  phoneRequired: 'RESERVATION_PHONE_REQUIRED',
  idempotencyMismatch: 'RESERVATION_IDEMPOTENCY_KEY_REUSED',
  invalidDate: 'RESERVATION_INVALID_DATE',
  spaceIncompatible: 'RESERVATION_SPACE_INCOMPATIBLE',
  noShowTooEarly: 'RESERVATION_NO_SHOW_TOO_EARLY',
  capacityTaken: 'RESERVATION_CAPACITY_TAKEN',
  activeLimit: 'RESERVATION_ACTIVE_LIMIT',
  creationLimit: 'RESERVATION_CREATION_LIMIT',
  /** 4B-2 — un plat de la précommande ne peut plus être servi tel quel. */
  itemsUnavailable: 'RESERVATION_ITEMS_UNAVAILABLE',
  /** 4B-2 — annulation refusée tant qu'une tentative de paiement est en cours. */
  paymentInProgress: 'RESERVATION_PAYMENT_IN_PROGRESS',
  /** 4B-2 — la réservation n'attend plus (ou pas encore) de paiement. */
  paymentClosed: 'RESERVATION_PAYMENT_CLOSED',
  /** 4B-2 — le total affiché au client n'est plus celui de la commande. */
  totalChanged: 'RESERVATION_TOTAL_CHANGED',
} as const;
