import {
  BRAZZAVILLE_UTC_OFFSET_MS,
  brazzavilleClock,
  datedClosureAt,
  OpeningDay,
  OpeningHoursRow,
  withinHoursAt,
} from '../vendors/vendor-opening.policy';
import { RESERVATION_TIMINGS } from './reservation-booking-vocab';
import { fromMinutes, toMinutes } from './reservation-config';
import { ReservationSpaceKind } from './reservation-vocab';

/**
 * Lot 4 — disponibilités datées : **moteur pur**, sans base ni horloge.
 *
 * Une seule règle, appelée par la lecture publique des heures libres ET par
 * la création d'une réservation (qui la rejoue sous verrou) : ce qui est
 * proposé est exactement ce qui est accepté. Le client ne recalcule jamais
 * la capacité (règle 2) ; il reçoit des heures, rien d'autre (Q12).
 *
 * Réutilise la politique d'ouverture (`withinHoursAt`, `datedClosureAt`,
 * `brazzavilleClock`) sans la recopier.
 *
 * Intervalles : une réservation occupe sa ressource sur
 * `[arrivée, arrivée + durée + marge)` — bornes **incluse / exclue**. Deux
 * réservations dont l'une finit (marge comprise) à l'instant où l'autre
 * commence ne se chevauchent pas.
 */

export interface AvailabilitySettings {
  slotDurationMin: number;
  slotStepMin: number;
  bufferMin: number;
  minLeadMin: number;
  maxAdvanceDays: number;
  maxPartySize: number;
}

export interface AvailabilitySpace {
  id: string;
  kind: ReservationSpaceKind;
  minGuests: number | null;
  maxGuests: number | null;
  seatCount: number | null;
  maxSeatsPerBooking: number | null;
  position: number;
}

/** Ce qu'une réservation active tient sur sa ressource. */
export interface Occupancy {
  reservationId: string;
  spaceId: string;
  partySize: number;
  arrivalAt: Date;
  occupiedUntil: Date;
}

export interface DayContext {
  /** « AAAA-MM-JJ », jour civil de Brazzaville. */
  date: string;
  now: Date;
  settings: AvailabilitySettings;
  /** Plages du jour de la semaine de `date` ("HH:mm", fin incluse). */
  windows: ReadonlyArray<{ startTime: string; endTime: string }>;
  /** Ressources non archivées. */
  spaces: readonly AvailabilitySpace[];
  /** Réservations qui tiennent de la capacité ce jour-là. */
  occupancies: readonly Occupancy[];
  openingHours: readonly OpeningHoursRow[];
  pausedUntil: Date | null;
  closures: ReadonlyArray<{ startsAt: Date; endsAt: Date }>;
  /** Le restaurant ferme les jours fériés et `date` en est un. */
  closedForHoliday: boolean;
}

export interface AvailableSlot {
  /** "HH:mm", heure de Brazzaville. */
  time: string;
  arrivalAt: Date;
}

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/**
 * OD-02 — délai minimal effectif d'une demande : celui du restaurant, jamais
 * moins de 60 min. La configuration du Lot 3 n'est pas modifiée.
 */
export function effectiveLeadMin(settings: { minLeadMin: number }): number {
  return Math.max(settings.minLeadMin, RESERVATION_TIMINGS.minEffectiveLeadMin);
}

/** OD-02 — le vendeur répond dans `min(demande + 30, arrivée − 30)`. */
export function responseDeadline(now: Date, arrivalAt: Date): Date {
  return new Date(
    Math.min(
      now.getTime() + RESERVATION_TIMINGS.vendorResponseMin * MINUTE_MS,
      arrivalAt.getTime() -
        RESERVATION_TIMINGS.responseBeforeArrivalMin * MINUTE_MS,
    ),
  );
}

/** OD-02 — le client paie dans `min(acceptation + 15, arrivée − 10)`. */
export function paymentDeadline(acceptedAt: Date, arrivalAt: Date): Date {
  return new Date(
    Math.min(
      acceptedAt.getTime() + RESERVATION_TIMINGS.paymentWindowMin * MINUTE_MS,
      arrivalAt.getTime() -
        RESERVATION_TIMINGS.paymentBeforeArrivalMin * MINUTE_MS,
    ),
  );
}
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** « AAAA-MM-JJ » réel (pas de 31 février), ou `null`. */
export function parseIsoDate(
  date: string,
): { y: number; m: number; d: number } | null {
  const match = ISO_DATE.exec(date);
  if (!match) return null;
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (
    probe.getUTCFullYear() !== y ||
    probe.getUTCMonth() !== m - 1 ||
    probe.getUTCDate() !== d
  ) {
    return null;
  }
  return { y, m, d };
}

/** Instant UTC d'une heure de Brazzaville (minutes depuis minuit) un jour donné. */
export function arrivalInstant(date: string, minutes: number): Date {
  const parsed = parseIsoDate(date);
  if (!parsed) throw new RangeError(`Date invalide : ${date}`);
  return new Date(
    Date.UTC(parsed.y, parsed.m - 1, parsed.d, 0, minutes) -
      BRAZZAVILLE_UTC_OFFSET_MS,
  );
}

/** Jour de la semaine (vocabulaire `DayOfWeek`) d'une date de Brazzaville. */
export function dayOfWeekOf(date: string): OpeningDay {
  return brazzavilleClock(arrivalInstant(date, 12 * 60)).day;
}

/** Fin du blocage d'une ressource pour une arrivée donnée. */
export function occupancyEnd(
  arrivalAt: Date,
  settings: Pick<AvailabilitySettings, 'slotDurationMin' | 'bufferMin'>,
): { endsAt: Date; occupiedUntil: Date } {
  const endsAt = new Date(
    arrivalAt.getTime() + settings.slotDurationMin * MINUTE_MS,
  );
  return {
    endsAt,
    occupiedUntil: new Date(endsAt.getTime() + settings.bufferMin * MINUTE_MS),
  };
}

function overlaps(a0: Date, a1: Date, b0: Date, b1: Date): boolean {
  return a0 < b1 && b0 < a1;
}

/** La ressource accueille-t-elle ce groupe, indépendamment de l'heure ? */
export function fitsParty(
  space: AvailabilitySpace,
  partySize: number,
): boolean {
  if (space.kind === 'TABLE') {
    return (
      (space.minGuests ?? 1) <= partySize && partySize <= (space.maxGuests ?? 0)
    );
  }
  return (
    partySize <= Math.min(space.maxSeatsPerBooking ?? 0, space.seatCount ?? 0)
  );
}

/**
 * P-02 (OD-17) — la première réservation active qu'une ressource, avec ses
 * nouvelles capacités, ne pourrait plus tenir ; `null` si toutes tiennent.
 *
 * Rejoue les réservations dans l'ordre d'arrivée, chacune contre celles déjà
 * placées : le pic d'occupation est atteint au début de l'une d'elles, et
 * toutes celles qui la précèdent sont déjà placées à cet instant.
 */
export function untenableReservation(
  space: AvailabilitySpace,
  held: readonly Occupancy[],
): Occupancy | null {
  const mine = held
    .filter((o) => o.spaceId === space.id)
    .sort((a, b) => a.arrivalAt.getTime() - b.arrivalAt.getTime());
  for (let i = 0; i < mine.length; i++) {
    const o = mine[i];
    if (!fitsParty(space, o.partySize)) return o;
    if (
      !isSpaceFree(
        space,
        o.partySize,
        o.arrivalAt,
        o.occupiedUntil,
        mine.slice(0, i),
      )
    ) {
      return o;
    }
  }
  return null;
}

/**
 * La ressource est-elle libre pour ce groupe sur `[start, until)` ?
 *
 * TABLE : aucune réservation qui se superpose (un groupe par table, D2).
 * SEATS : au **pic** d'occupation de l'intervalle, il reste assez de places —
 * pas la somme de toutes les réservations qui touchent l'intervalle, qui
 * refuserait deux groupes successifs ne se croisant jamais.
 */
export function isSpaceFree(
  space: AvailabilitySpace,
  partySize: number,
  start: Date,
  until: Date,
  occupancies: readonly Occupancy[],
  excludeReservationId?: string,
): boolean {
  const overlapping = occupancies.filter(
    (o) =>
      o.spaceId === space.id &&
      o.reservationId !== excludeReservationId &&
      overlaps(start, until, o.arrivalAt, o.occupiedUntil),
  );
  if (space.kind === 'TABLE') return overlapping.length === 0;

  // Le pic d'une somme de créneaux est atteint au début de l'un d'eux.
  const points = [
    start,
    ...overlapping.map((o) => o.arrivalAt).filter((t) => t > start),
  ];
  const peak = Math.max(
    ...points.map((p) =>
      overlapping
        .filter((o) => o.arrivalAt <= p && p < o.occupiedUntil)
        .reduce((sum, o) => sum + o.partySize, 0),
    ),
  );
  return peak + partySize <= (space.seatCount ?? 0);
}

/** Ordre d'attribution : la plus petite ressource qui convient (Q6). */
export function attributionOrder(
  spaces: readonly AvailabilitySpace[],
): AvailabilitySpace[] {
  const capacity = (s: AvailabilitySpace) =>
    s.kind === 'TABLE' ? (s.maxGuests ?? 0) : (s.seatCount ?? 0);
  return [...spaces].sort(
    (a, b) =>
      // Une table entière avant un espace de places : le groupe garde sa table.
      (a.kind === 'TABLE' ? 0 : 1) - (b.kind === 'TABLE' ? 0 : 1) ||
      capacity(a) - capacity(b) ||
      a.position - b.position ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

/** La ressource attribuée à ce groupe à cette heure, ou `null` (complet). */
export function pickSpace(
  spaces: readonly AvailabilitySpace[],
  partySize: number,
  arrivalAt: Date,
  settings: Pick<AvailabilitySettings, 'slotDurationMin' | 'bufferMin'>,
  occupancies: readonly Occupancy[],
  options: { excludeReservationId?: string; kind?: ReservationSpaceKind } = {},
): AvailabilitySpace | null {
  const { occupiedUntil } = occupancyEnd(arrivalAt, settings);
  return (
    attributionOrder(spaces).find(
      (space) =>
        (options.kind === undefined || space.kind === options.kind) &&
        fitsParty(space, partySize) &&
        isSpaceFree(
          space,
          partySize,
          arrivalAt,
          occupiedUntil,
          occupancies,
          options.excludeReservationId,
        ),
    ) ?? null
  );
}

/**
 * Heures d'arrivée encore libres pour ce groupe, ce jour-là.
 *
 * Une heure est proposée si, et seulement si : elle tombe dans une plage, au
 * pas ; elle respecte le délai minimal et l'horizon ; le restaurant est
 * ouvert à cette heure (horaires, pause, congé, jour férié) ; une ressource
 * qui accueille le groupe est libre sur toute l'occupation.
 */
export function availableSlots(
  ctx: DayContext,
  partySize: number,
): AvailableSlot[] {
  const { settings } = ctx;
  if (partySize < 1 || partySize > settings.maxPartySize) return [];
  if (ctx.closedForHoliday) return [];
  if (!parseIsoDate(ctx.date)) return [];

  const earliest = ctx.now.getTime() + effectiveLeadMin(settings) * MINUTE_MS;
  const latest = ctx.now.getTime() + settings.maxAdvanceDays * DAY_MS;
  const day = dayOfWeekOf(ctx.date);
  const slots: AvailableSlot[] = [];

  for (const window of ctx.windows) {
    const end = toMinutes(window.endTime);
    for (
      let minutes = toMinutes(window.startTime);
      minutes <= end;
      minutes += settings.slotStepMin
    ) {
      const arrivalAt = arrivalInstant(ctx.date, minutes);
      const t = arrivalAt.getTime();
      if (t < earliest || t > latest) continue;
      if (!withinHoursAt(ctx.openingHours, day, minutes)) continue;
      if (datedClosureAt(arrivalAt, ctx.pausedUntil, ctx.closures, ctx.now)) {
        continue;
      }
      if (
        !pickSpace(ctx.spaces, partySize, arrivalAt, settings, ctx.occupancies)
      ) {
        continue;
      }
      slots.push({ time: fromMinutes(minutes), arrivalAt });
    }
  }
  return slots.sort((a, b) => a.arrivalAt.getTime() - b.arrivalAt.getTime());
}
