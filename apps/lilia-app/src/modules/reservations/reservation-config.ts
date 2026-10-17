import {
  OpeningDay,
  OpeningHoursRow,
  withinHoursAt,
} from '../vendors/vendor-opening.policy';
import {
  RESERVATION_LIMITS as L,
  RESERVATION_SPACE_KINDS,
  ReservationSpaceKind,
} from './reservation-vocab';

/**
 * Premium (Lot 3) — moteur PUR de la configuration de réservation.
 *
 * Une seule fonction, `evaluateReservationDraft`, appelée par la
 * prévisualisation (sans écriture) **et** par l'enregistrement : ce que
 * l'aperçu accepte, le `PUT` l'accepte, et inversement. Aucun accès à la base :
 * le service lui passe ce qu'il a lu (ressources existantes, horaires,
 * interrupteur, droit).
 *
 * Deux sortes de constats :
 *  - `ERROR` : le `PUT` refuse (400 `RESERVATION_SETTINGS_INVALID`) ;
 *  - `WARNING` : signalé, jamais bloquant (horaires d'ouverture, tailles de
 *    groupe non couvertes, interrupteur éteint, droit absent…).
 *
 * Règles : `03-approval.md` du Lot 3 (D1–D15, Q1–Q7, lectures §12).
 */

/** Ordre d'affichage : la semaine commence le lundi. */
export const WEEK_DAYS: readonly OpeningDay[] = [
  'LUNDI',
  'MARDI',
  'MERCREDI',
  'JEUDI',
  'VENDREDI',
  'SAMEDI',
  'DIMANCHE',
];

const MINUTES_PER_DAY = 24 * 60;
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
/** `Cc` (C0, DEL, C1) et `Cf` (largeur nulle, BOM, bidi). */
const INVISIBLE_CHARS = /[\p{Cc}\p{Cf}]/u;

export interface DraftSpace {
  /** Absent = ressource nouvelle. Présent = ressource existante de la boutique. */
  id?: string | null;
  kind: string;
  label: string;
  minGuests?: number | null;
  maxGuests?: number | null;
  seatCount?: number | null;
  maxSeatsPerBooking?: number | null;
  /** Seule façon d'archiver (Q1) : jamais par omission. */
  archived?: boolean;
}

export interface DraftWindow {
  dayOfWeek: string;
  startTime: string;
  endTime: string;
}

export interface ReservationDraft {
  enabled: boolean;
  slotDurationMin: number;
  slotStepMin: number;
  bufferMin: number;
  minLeadMin: number;
  maxAdvanceDays: number;
  maxPartySize: number;
  spaces: DraftSpace[];
  windows: DraftWindow[];
}

export interface ExistingSpace {
  id: string;
  /** Type enregistré : figé en v1 (archiver puis recréer pour en changer). */
  kind: string;
  label: string;
  archivedAt: Date | null;
}

export interface EvaluationContext {
  /** Toutes les ressources de la boutique, archivées comprises. */
  existingSpaces: readonly ExistingSpace[];
  openingHours: readonly OpeningHoursRow[];
  platformEnabled: boolean;
  entitled: boolean;
}

export type IssueSeverity = 'ERROR' | 'WARNING';

export interface ReservationIssue {
  severity: IssueSeverity;
  code: string;
  /** Chemin du champ visé (`spaces[2].label`), `null` pour un constat global. */
  field: string | null;
  message: string;
  /** `PARTY_SIZES_UNCOVERED` : tailles de groupe sans ressource. */
  partySizes?: number[];
}

/** Ce que le service écrira, une fois le brouillon accepté. */
export interface PlannedSpace {
  id: string | null;
  action: 'CREATE' | 'UPDATE' | 'ARCHIVE' | 'KEEP_ARCHIVED';
  kind: ReservationSpaceKind;
  label: string;
  labelKey: string;
  minGuests: number | null;
  maxGuests: number | null;
  seatCount: number | null;
  maxSeatsPerBooking: number | null;
  position: number;
}

export interface PreviewSlot {
  time: string;
  inOpeningHours: boolean;
  occupationPastClosing: boolean;
}

export interface PreviewDay {
  dayOfWeek: OpeningDay;
  /** Horaire d'ouverture propre au jour, `null` si fermé ou non renseigné. */
  opening: { openTime: string; closeTime: string } | null;
  slots: PreviewSlot[];
}

export interface ReservationPreview {
  capacity: {
    tables: number;
    /** Somme des `maxGuests` des tables actives. */
    tableCovers: number;
    seatSpaces: number;
    seats: number;
    totalCovers: number;
  };
  /** Tailles de 1 à `maxPartySize` qu'aucune ressource active n'accueille. */
  uncoveredPartySizes: number[];
  days: PreviewDay[];
}

export interface ReservationEvaluation {
  issues: ReservationIssue[];
  hasErrors: boolean;
  preview: ReservationPreview;
  plannedSpaces: PlannedSpace[];
  windows: DraftWindow[];
}

/** Libellé affiché : NFC, espaces de bord retirés, espaces internes réduits. */
export function normalizeLabel(raw: string): string {
  return raw.normalize('NFC').trim().replace(/\s+/g, ' ');
}

/** Clé d'unicité : libellé normalisé en minuscules, accents conservés (Q4). */
export function labelKeyOf(raw: string): string {
  return normalizeLabel(raw).toLocaleLowerCase('fr-FR');
}

export function toMinutes(time: string): number {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
}

export function fromMinutes(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** Une ressource active accueille-t-elle un groupe de `n` personnes ? */
function accepts(space: PlannedSpace, n: number): boolean {
  if (space.kind === 'TABLE') {
    return space.minGuests! <= n && n <= space.maxGuests!;
  }
  return n <= Math.min(space.maxSeatsPerBooking!, space.seatCount!);
}

function isInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v);
}

function inRange(v: unknown, min: number, max: number): v is number {
  return isInt(v) && v >= min && v <= max;
}

/** Occupation de la semaine type : `true` = ouvert à cette minute. */
function weeklyOpenMap(hours: readonly OpeningHoursRow[]): boolean[] {
  const map = new Array<boolean>(7 * MINUTES_PER_DAY);
  WEEK_DAYS.forEach((day, d) => {
    for (let m = 0; m < MINUTES_PER_DAY; m++) {
      map[d * MINUTES_PER_DAY + m] = withinHoursAt(hours, day, m);
    }
  });
  return map;
}

export function evaluateReservationDraft(
  draft: ReservationDraft,
  ctx: EvaluationContext,
): ReservationEvaluation {
  const issues: ReservationIssue[] = [];
  const error = (code: string, field: string | null, message: string) =>
    issues.push({ severity: 'ERROR', code, field, message });
  const warning = (
    code: string,
    field: string | null,
    message: string,
    extra: Partial<ReservationIssue> = {},
  ) => issues.push({ severity: 'WARNING', code, field, message, ...extra });

  // ── 1. Règles de créneau (D5–D10) ─────────────────────────────────────────
  const ranged: Array<
    [keyof ReservationDraft, { min: number; max: number }, string]
  > = [
    ['slotDurationMin', L.slotDurationMin, 'La durée d’occupation'],
    ['bufferMin', L.bufferMin, 'La marge entre deux réservations'],
    ['minLeadMin', L.minLeadMin, 'Le délai minimal avant l’arrivée'],
    ['maxAdvanceDays', L.maxAdvanceDays, 'L’horizon de réservation'],
    ['maxPartySize', L.maxPartySize, 'La taille de groupe maximale'],
  ];
  for (const [field, bounds, label] of ranged) {
    if (!inRange(draft[field], bounds.min, bounds.max)) {
      error(
        'OUT_OF_RANGE',
        field,
        `${label} doit être un nombre entier entre ${bounds.min} et ${bounds.max}.`,
      );
    }
  }
  const stepValid = (L.slotStepMin.allowed as readonly number[]).includes(
    draft.slotStepMin,
  );
  if (!stepValid) {
    error(
      'OUT_OF_RANGE',
      'slotStepMin',
      `L’intervalle entre deux arrivées doit être ${L.slotStepMin.allowed.join(', ')} minutes.`,
    );
  }

  // ── 2. Ressources : tables et espaces de places ───────────────────────────
  const existingById = new Map(ctx.existingSpaces.map((s) => [s.id, s]));
  const seenIds = new Set<string>();
  const planned: PlannedSpace[] = [];

  draft.spaces.forEach((raw, i) => {
    const path = `spaces[${i}]`;
    const id = raw.id ?? null;
    const kindValid = (RESERVATION_SPACE_KINDS as readonly string[]).includes(
      raw.kind,
    );
    if (!kindValid) {
      error('OUT_OF_RANGE', `${path}.kind`, 'Type de ressource inconnu.');
      return;
    }
    const kind = raw.kind as ReservationSpaceKind;

    let action: PlannedSpace['action'] = 'CREATE';
    if (id !== null) {
      if (seenIds.has(id)) {
        error(
          'DUPLICATE_RESOURCE_ID',
          `${path}.id`,
          'Cette ressource figure deux fois dans la configuration.',
        );
        return;
      }
      seenIds.add(id);
      const existing = existingById.get(id);
      // Inconnue ou d'une autre boutique : même réponse, aucune fuite.
      if (!existing) {
        error(
          'UNKNOWN_RESOURCE_ID',
          `${path}.id`,
          'Cette ressource n’existe pas dans votre restaurant.',
        );
        return;
      }
      // Type figé en v1 : les réservations des lots suivants référenceront la
      // ressource par son id ; une table ne devient pas un espace de places.
      if (existing.kind !== kind) {
        error(
          'RESOURCE_KIND_CHANGED',
          `${path}.kind`,
          `Le type de « ${existing.label} » ne peut pas changer : archivez-la et créez une nouvelle ressource.`,
        );
        return;
      }
      if (existing.archivedAt) {
        if (raw.archived === true) {
          planned.push(keepArchived(id, kind, existing.label, i));
          return;
        }
        error(
          'RESOURCE_ARCHIVED',
          `${path}.id`,
          `« ${existing.label} » est archivée : créez une nouvelle ressource.`,
        );
        return;
      }
      if (raw.archived === true) {
        planned.push({
          ...keepArchived(id, kind, existing.label, i),
          action: 'ARCHIVE',
        });
        return;
      }
      action = 'UPDATE';
    } else if (raw.archived === true) {
      // Lecture §12.1 : créer une ressource déjà archivée n'a pas de sens.
      error(
        'ARCHIVED_ON_CREATE',
        `${path}.archived`,
        'Une nouvelle ressource ne peut pas être créée archivée.',
      );
      return;
    }

    // Ni contrôle (C0, DEL, C1) ni format (largeur nulle, BOM, bidi) : deux
    // libellés identiques à l'écran seraient distincts pour l'unicité (D15).
    // Constat sous le champ, pas un 400 de DTO sans code ni champ.
    if (INVISIBLE_CHARS.test(raw.label ?? '')) {
      error(
        'LABEL_INVALID_CHARS',
        `${path}.label`,
        'Le nom contient un caractère invisible ou de contrôle : retapez-le.',
      );
      return;
    }

    const label = normalizeLabel(raw.label ?? '');
    const length = Array.from(label).length;
    if (length < 1 || length > L.labelMaxLength) {
      error(
        'LABEL_LENGTH',
        `${path}.label`,
        `Le nom doit compter de 1 à ${L.labelMaxLength} caractères.`,
      );
    }

    const space: PlannedSpace = {
      id,
      action,
      kind,
      label,
      labelKey: labelKeyOf(label),
      minGuests: null,
      maxGuests: null,
      seatCount: null,
      maxSeatsPerBooking: null,
      position: i,
    };

    if (kind === 'TABLE') {
      const { minGuests, maxGuests } = raw;
      if (
        !inRange(minGuests, 1, L.tableGuestsMax) ||
        !inRange(maxGuests, 1, L.tableGuestsMax) ||
        minGuests > maxGuests
      ) {
        error(
          'TABLE_GUESTS_RANGE',
          `${path}.maxGuests`,
          `Une table accueille de 1 à ${L.tableGuestsMax} personnes, le minimum ne dépassant pas le maximum.`,
        );
      } else {
        space.minGuests = minGuests;
        space.maxGuests = maxGuests;
      }
    } else {
      const { seatCount, maxSeatsPerBooking } = raw;
      if (
        !inRange(seatCount, 1, L.seatCountMax) ||
        !inRange(maxSeatsPerBooking, 1, L.maxSeatsPerBookingMax) ||
        maxSeatsPerBooking > seatCount
      ) {
        error(
          'SEATS_RANGE',
          `${path}.maxSeatsPerBooking`,
          `Un espace compte de 1 à ${L.seatCountMax} places ; une réservation y prend de 1 à ${L.maxSeatsPerBookingMax} places, sans dépasser la capacité.`,
        );
      } else {
        space.seatCount = seatCount;
        space.maxSeatsPerBooking = maxSeatsPerBooking;
      }
    }
    planned.push(space);
  });

  // Q1 : une ressource active absente du brouillon n'est jamais archivée en
  // silence — c'est une erreur.
  for (const existing of ctx.existingSpaces) {
    if (!existing.archivedAt && !seenIds.has(existing.id)) {
      error(
        'MISSING_RESOURCE',
        'spaces',
        `« ${existing.label} » manque à la configuration. Pour la retirer, archivez-la.`,
      );
    }
  }

  const active = planned.filter(
    (s) => s.action === 'CREATE' || s.action === 'UPDATE',
  );
  const complete = active.filter((s) =>
    s.kind === 'TABLE' ? s.maxGuests !== null : s.seatCount !== null,
  );

  // Unicité des libellés parmi les ressources actives (D15, Q4).
  const keys = new Set<string>();
  for (const s of active) {
    if (!s.labelKey) continue;
    if (keys.has(s.labelKey)) {
      error(
        'DUPLICATE_LABEL',
        `spaces[${s.position}].label`,
        `Le nom « ${s.label} » est déjà utilisé.`,
      );
    } else {
      keys.add(s.labelKey);
    }
  }

  const tables = complete.filter((s) => s.kind === 'TABLE');
  const seatSpaces = complete.filter((s) => s.kind === 'SEATS');
  const tableCount = active.filter((s) => s.kind === 'TABLE').length;
  const seatSpaceCount = active.filter((s) => s.kind === 'SEATS').length;
  const seats = seatSpaces.reduce((sum, s) => sum + s.seatCount!, 0);
  if (tableCount > L.maxTables) {
    error('LIMIT_EXCEEDED', 'spaces', `${L.maxTables} tables au plus.`);
  }
  if (seatSpaceCount > L.maxSeatSpaces) {
    error(
      'LIMIT_EXCEEDED',
      'spaces',
      `${L.maxSeatSpaces} espaces de places au plus.`,
    );
  }
  if (seats > L.maxTotalSeats) {
    error(
      'LIMIT_EXCEEDED',
      'spaces',
      `${L.maxTotalSeats} places au plus, tous espaces confondus.`,
    );
  }

  // ── 3. Plages hebdomadaires (D3) ──────────────────────────────────────────
  const validWindows: Array<DraftWindow & { index: number }> = [];
  draft.windows.forEach((w, i) => {
    const path = `windows[${i}]`;
    if (!(WEEK_DAYS as readonly string[]).includes(w.dayOfWeek)) {
      error('OUT_OF_RANGE', `${path}.dayOfWeek`, 'Jour inconnu.');
      return;
    }
    const startOk = TIME_PATTERN.test(w.startTime ?? '');
    const endOk = TIME_PATTERN.test(w.endTime ?? '');
    if (!startOk || !endOk) {
      error(
        'TIME_FORMAT',
        `${path}.${startOk ? 'endTime' : 'startTime'}`,
        'Heure attendue au format HH:mm (ex. 12:30).',
      );
      return;
    }
    if (toMinutes(w.startTime) >= toMinutes(w.endTime)) {
      error(
        'WINDOW_EMPTY',
        `${path}.endTime`,
        'La dernière arrivée doit être après la première, le même jour.',
      );
      return;
    }
    validWindows.push({ ...w, index: i });
  });

  for (const day of WEEK_DAYS) {
    const ofDay = validWindows
      .filter((w) => w.dayOfWeek === day)
      .sort((a, b) => toMinutes(a.startTime) - toMinutes(b.startTime));
    if (ofDay.length > L.maxWindowsPerDay) {
      error(
        'TOO_MANY_WINDOWS',
        `windows[${ofDay[L.maxWindowsPerDay].index}]`,
        `${L.maxWindowsPerDay} plages au plus par jour (${day.toLowerCase()}).`,
      );
    }
    // Comparée à la fin la plus tardive déjà vue, pas à la seule précédente :
    // une longue plage qui en couvre plusieurs les fait toutes signaler.
    let latestEnd = -1;
    for (let k = 0; k < ofDay.length; k++) {
      const start = toMinutes(ofDay[k].startTime);
      // Fin incluse : 12:00–14:00 et 14:00–16:00 proposeraient deux fois 14:00.
      const overlaps = k > 0 && start <= latestEnd;
      latestEnd = Math.max(latestEnd, toMinutes(ofDay[k].endTime));
      if (overlaps) {
        error(
          'WINDOW_OVERLAP',
          `windows[${ofDay[k].index}].startTime`,
          `Cette plage chevauche une autre plage (${day.toLowerCase()}).`,
        );
      }
    }
  }

  // ── 4. Exigences d'une configuration activée ──────────────────────────────
  // Désactivée, elle peut rester incomplète : c'est un brouillon.
  if (draft.enabled) {
    if (active.length === 0) {
      error(
        'NO_RESOURCE',
        'spaces',
        'Ajoutez au moins une table ou un espace de places pour activer la réservation.',
      );
    }
    if (draft.windows.length === 0) {
      error(
        'NO_WINDOW',
        'windows',
        'Ajoutez au moins une plage horaire pour activer la réservation.',
      );
    }
  }

  // ── 5. Tailles de groupe (D10, Q2) ────────────────────────────────────────
  const uncoveredPartySizes: number[] = [];
  if (inRange(draft.maxPartySize, L.maxPartySize.min, L.maxPartySize.max)) {
    for (let n = 1; n <= draft.maxPartySize; n++) {
      if (!complete.some((s) => accepts(s, n))) uncoveredPartySizes.push(n);
    }
    const maxUnreachable = uncoveredPartySizes.includes(draft.maxPartySize);
    if (draft.enabled && complete.length > 0 && maxUnreachable) {
      error(
        'PARTY_SIZE_UNREACHABLE',
        'maxPartySize',
        `Aucune table ni aucun espace n’accueille un groupe de ${draft.maxPartySize} personnes.`,
      );
    }
    if (complete.length > 0 && uncoveredPartySizes.length > 0) {
      warning(
        'PARTY_SIZES_UNCOVERED',
        'spaces',
        `Aucune ressource n’accueille un groupe de ${uncoveredPartySizes.join(', ')} personne(s).`,
        { partySizes: uncoveredPartySizes },
      );
    }
  }

  // ── 6. Aperçu et compatibilité avec les horaires (D4, Q3) ─────────────────
  const openMap = weeklyOpenMap(ctx.openingHours);
  const durationValid = inRange(
    draft.slotDurationMin,
    L.slotDurationMin.min,
    L.slotDurationMin.max,
  );
  const isOpenAt = (dayIndex: number, minute: number) =>
    openMap[(dayIndex * MINUTES_PER_DAY + minute) % openMap.length];

  const days: PreviewDay[] = WEEK_DAYS.map((day) => {
    const own = ctx.openingHours.find((h) => h.dayOfWeek === day);
    return {
      dayOfWeek: day,
      opening:
        own && !own.isClosed
          ? { openTime: own.openTime, closeTime: own.closeTime }
          : null,
      slots: [],
    };
  });

  if (stepValid) {
    for (const w of validWindows) {
      const d = WEEK_DAYS.indexOf(w.dayOfWeek as OpeningDay);
      const slots: PreviewSlot[] = [];
      // Départs à start, start + pas… tant que ≤ fin (dernière arrivée incluse).
      for (
        let t = toMinutes(w.startTime);
        t <= toMinutes(w.endTime);
        t += draft.slotStepMin
      ) {
        const inHours = isOpenAt(d, t);
        let pastClosing = false;
        if (inHours && durationValid) {
          // Lecture §12.2–3 : l'occupation seule (sans la marge), jusqu'à la
          // fin de la période ouverte qui contient l'arrivée, nuit comprise.
          for (let m = 1; m < draft.slotDurationMin; m++) {
            if (!isOpenAt(d, t + m)) {
              pastClosing = true;
              break;
            }
          }
        }
        slots.push({
          time: fromMinutes(t),
          inOpeningHours: inHours,
          occupationPastClosing: pastClosing,
        });
      }
      days[d].slots.push(...slots);

      const path = `windows[${w.index}]`;
      const inside = slots.filter((s) => s.inOpeningHours).length;
      if (inside === 0) {
        if (!days[d].opening) {
          warning(
            'DAY_CLOSED',
            path,
            `Le restaurant est fermé ce jour-là (${w.dayOfWeek.toLowerCase()}) : aucun créneau ne sera proposé.`,
          );
        } else {
          warning(
            'OUTSIDE_OPENING_HOURS',
            path,
            'Cette plage est entièrement hors des horaires d’ouverture : aucun créneau ne sera proposé.',
          );
        }
      } else if (inside < slots.length) {
        warning(
          'OUTSIDE_OPENING_HOURS',
          path,
          'Une partie de cette plage est hors des horaires d’ouverture : ces créneaux ne seront pas proposés.',
        );
      }
      if (slots.some((s) => s.occupationPastClosing)) {
        warning(
          'OCCUPATION_PAST_CLOSING',
          path,
          `Avec ${draft.slotDurationMin} min d’occupation, les dernières arrivées de cette plage dépassent l’heure de fermeture.`,
        );
      }
    }
  }
  for (const day of days) {
    day.slots.sort((a, b) => toMinutes(a.time) - toMinutes(b.time));
  }

  if (!ctx.platformEnabled) {
    warning(
      'PLATFORM_DISABLED',
      null,
      'La réservation sur place n’est pas encore ouverte aux clients sur Lilia Food.',
    );
  }
  if (!ctx.entitled) {
    warning(
      'NOT_ENTITLED',
      null,
      'Un abonnement Premium actif est nécessaire pour enregistrer cette configuration.',
    );
  }

  const tableCovers = tables.reduce((sum, s) => sum + s.maxGuests!, 0);
  return {
    issues,
    hasErrors: issues.some((i) => i.severity === 'ERROR'),
    preview: {
      capacity: {
        tables: tables.length,
        tableCovers,
        seatSpaces: seatSpaces.length,
        seats,
        totalCovers: tableCovers + seats,
      },
      uncoveredPartySizes,
      days,
    },
    plannedSpaces: planned,
    windows: validWindows.map(({ dayOfWeek, startTime, endTime }) => ({
      dayOfWeek,
      startTime,
      endTime,
    })),
  };
}

function keepArchived(
  id: string,
  kind: ReservationSpaceKind,
  label: string,
  position: number,
): PlannedSpace {
  return {
    id,
    action: 'KEEP_ARCHIVED',
    kind,
    label,
    labelKey: labelKeyOf(label),
    minGuests: null,
    maxGuests: null,
    seatCount: null,
    maxSeatsPerBooking: null,
    position,
  };
}
