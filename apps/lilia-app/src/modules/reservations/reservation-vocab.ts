/**
 * Premium (Lot 3) — vocabulaire et bornes de la configuration de réservation.
 *
 * Miroirs exacts des CHECK de la migration `20261012120000_reservation_settings`
 * (règle 14 : TEXT + CHECK + liste TypeScript). Les décisions qui fixent ces
 * valeurs (D5–D10, D15) sont dans `lilia-engineering/features/
 * 2026-10-12-premium-lot3-reservations-config/03-approval.md`.
 *
 * Les applications reçoivent ces bornes du serveur (`limits` du `GET`) ; elles
 * ne les recopient pas.
 */
export const RESERVATION_SPACE_KINDS = ['TABLE', 'SEATS'] as const;
export type ReservationSpaceKind = (typeof RESERVATION_SPACE_KINDS)[number];

export const RESERVATION_LIMITS = {
  slotDurationMin: { min: 30, max: 240, default: 90 },
  slotStepMin: { allowed: [15, 30, 60] as const, default: 30 },
  bufferMin: { min: 0, max: 60, default: 15 },
  minLeadMin: { min: 30, max: 2880, default: 120 },
  maxAdvanceDays: { min: 1, max: 90, default: 30 },
  maxPartySize: { min: 1, max: 50, default: 8 },
  /** Groupe admis par une table : 1 ≤ min ≤ max ≤ 50. */
  tableGuestsMax: 50,
  /** Places d'un espace de places. */
  seatCountMax: 200,
  /** Places au plus par réservation dans un espace. */
  maxSeatsPerBookingMax: 50,
  maxTables: 50,
  maxSeatSpaces: 5,
  maxTotalSeats: 200,
  maxWindowsPerDay: 3,
  labelMaxLength: 40,
} as const;

/** Le droit Premium qui ouvre l'écriture (Lot 2, `plans.ts`). */
export const RESERVATION_ENTITLEMENT = 'ON_SITE_RESERVATIONS' as const;

/** Seul type de vendeur admis en v1 (D13). */
export const RESERVATION_ELIGIBLE_VENDOR_TYPE = 'RESTAURANT' as const;

/** Codes d'erreur HTTP stables, lus par l'app vendeurs (`error.code`). */
export const RESERVATION_ERROR_CODES = {
  invalid: 'RESERVATION_SETTINGS_INVALID',
  conflict: 'RESERVATION_SETTINGS_CONFLICT',
  premiumRequired: 'PREMIUM_REQUIRED',
  vendorType: 'RESERVATIONS_NOT_AVAILABLE_FOR_VENDOR_TYPE',
} as const;
