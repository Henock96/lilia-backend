/**
 * Politique d'ouverture d'un vendeur (F3-03, R-03.1) — fonction pure.
 *
 * ## Pourquoi un seul calcul
 *
 * L'ouverture était décidée à deux endroits qui ne se parlaient pas : le cron
 * (horaires → colonne `isOpen`, chaque minute) et le checkout, qui **lisait la
 * colonne**. Entre deux passages du cron, une boutique fermée prenait encore
 * commande (écart E7). Le checkout et le cron appellent désormais la même
 * fonction ; la colonne n'est plus qu'un cache pour les listes publiques.
 *
 * ## Ordre des règles (la première qui ferme gagne)
 *
 *  1. pause datée (`pausedUntil > now`) — « fermé jusqu'à 14:30 » ;
 *  2. congé déclaré couvrant `now` ;
 *  3. jour férié, si le vendeur ferme les jours fériés ;
 *  4. interrupteur manuel historique (`manualOverride`) : l'état posé à la
 *     main est conservé tel quel ;
 *  5. horaires hebdomadaires, traversée de minuit comprise.
 *
 * Les trois premières sont **datées** : elles se terminent seules. C'est ce
 * qui manquait à `manualOverride`, qu'un vendeur oubliait de relâcher.
 *
 * Heure de Brazzaville = UTC+1, sans heure d'été : le décalage est fixe.
 */

export const BRAZZAVILLE_UTC_OFFSET_MS = 60 * 60 * 1000;

const DAYS = [
  'DIMANCHE',
  'LUNDI',
  'MARDI',
  'MERCREDI',
  'JEUDI',
  'VENDREDI',
  'SAMEDI',
] as const;
export type OpeningDay = (typeof DAYS)[number];

export interface OpeningHoursRow {
  dayOfWeek: string;
  openTime: string; // "HH:mm"
  closeTime: string; // "HH:mm"
  isClosed: boolean;
}

export interface OpeningInput {
  now: Date;
  hours: readonly OpeningHoursRow[];
  manualOverride: boolean;
  /** Colonne `isOpen` : n'est lue que si `manualOverride` (état posé à la main). */
  currentIsOpen: boolean;
  pausedUntil: Date | null;
  /** Congés du vendeur ; ceux qui ne couvrent pas `now` sont ignorés. */
  closures: ReadonlyArray<{ startsAt: Date; endsAt: Date }>;
  isHoliday: boolean;
  closedOnHolidays: boolean;
}

export type OpeningReason =
  | 'OPEN'
  | 'PAUSED'
  | 'CLOSURE'
  | 'HOLIDAY'
  | 'MANUAL'
  | 'OUTSIDE_HOURS';

export interface OpeningDecision {
  open: boolean;
  reason: OpeningReason;
  /** Fin connue de la fermeture datée (pause ou congé), sinon `null`. */
  until: Date | null;
}

/** Jour, minute et date civile à Brazzaville. */
export function brazzavilleClock(now: Date): {
  day: OpeningDay;
  previousDay: OpeningDay;
  minutes: number;
  /** « AAAA-MM-JJ » — clé de `PublicHoliday.date`. */
  isoDate: string;
} {
  const local = new Date(now.getTime() + BRAZZAVILLE_UTC_OFFSET_MS);
  const dayIndex = local.getUTCDay();
  return {
    day: DAYS[dayIndex],
    previousDay: DAYS[(dayIndex + 6) % 7],
    minutes: local.getUTCHours() * 60 + local.getUTCMinutes(),
    isoDate: local.toISOString().slice(0, 10),
  };
}

export function decideOpening(input: OpeningInput): OpeningDecision {
  const { now } = input;

  if (input.pausedUntil && input.pausedUntil > now) {
    return { open: false, reason: 'PAUSED', until: input.pausedUntil };
  }

  const closure = input.closures
    .filter((c) => c.startsAt <= now && c.endsAt > now)
    // Deux congés qui se chevauchent : on annonce la fin la plus tardive.
    .sort((a, b) => b.endsAt.getTime() - a.endsAt.getTime())[0];
  if (closure) {
    return { open: false, reason: 'CLOSURE', until: closure.endsAt };
  }

  if (input.isHoliday && input.closedOnHolidays) {
    return { open: false, reason: 'HOLIDAY', until: null };
  }

  if (input.manualOverride) {
    return {
      open: input.currentIsOpen,
      reason: input.currentIsOpen ? 'OPEN' : 'MANUAL',
      until: null,
    };
  }

  return withinHours(input.hours, now)
    ? { open: true, reason: 'OPEN', until: null }
    : { open: false, reason: 'OUTSIDE_HOURS', until: null };
}

/** Fermeture datée (pause ou congé) couvrant un instant futur — R-03.3. */
export function datedClosureAt(
  at: Date,
  pausedUntil: Date | null,
  closures: ReadonlyArray<{ startsAt: Date; endsAt: Date }>,
  now: Date,
): { reason: 'PAUSED' | 'CLOSURE'; until: Date } | null {
  if (pausedUntil && pausedUntil > now && at < pausedUntil) {
    return { reason: 'PAUSED', until: pausedUntil };
  }
  const closure = closures.find((c) => c.startsAt <= at && c.endsAt > at);
  return closure ? { reason: 'CLOSURE', until: closure.endsAt } : null;
}

export function withinHours(
  hours: readonly OpeningHoursRow[],
  now: Date,
): boolean {
  const clock = brazzavilleClock(now);
  const today = hours.find((h) => h.dayOfWeek === clock.day);
  const yesterday = hours.find((h) => h.dayOfWeek === clock.previousDay);
  return (
    matchesToday(clock.minutes, today) ||
    matchesOvernightFromYesterday(clock.minutes, yesterday)
  );
}

function matchesToday(minutes: number, hours?: OpeningHoursRow): boolean {
  if (!hours || hours.isClosed) return false;
  const open = toMinutes(hours.openTime);
  const close = toMinutes(hours.closeTime);
  // 08:00 → 22:00 ; ou 20:00 → 02:00, dont la partie « avant minuit ».
  return close > open
    ? minutes >= open && minutes < close
    : minutes >= open || minutes < close;
}

/** L'horaire de la veille (20:00 → 02:00) déborde sur aujourd'hui. */
function matchesOvernightFromYesterday(
  minutes: number,
  hours?: OpeningHoursRow,
): boolean {
  if (!hours || hours.isClosed) return false;
  const open = toMinutes(hours.openTime);
  const close = toMinutes(hours.closeTime);
  if (close >= open) return false;
  return minutes < close;
}

function toMinutes(time: string): number {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
}
