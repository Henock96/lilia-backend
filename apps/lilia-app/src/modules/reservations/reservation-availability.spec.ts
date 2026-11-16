import {
  arrivalInstant,
  AvailabilitySpace,
  availableSlots,
  DayContext,
  dayOfWeekOf,
  isSpaceFree,
  Occupancy,
  parseIsoDate,
  pickSpace,
} from './reservation-availability';

/**
 * Lot 4 — moteur des disponibilités datées. Toutes les heures sont celles de
 * Brazzaville (UTC+1) : 12:00 locale = 11:00 UTC.
 */

// Mardi 20 octobre 2026.
const DATE = '2026-10-20';
// La veille à 10:00 locale : délai minimal (2 h) et horizon (30 j) satisfaits.
const NOW = new Date('2026-10-19T09:00:00Z');

const table = (
  id: string,
  min: number,
  max: number,
  position = 0,
): AvailabilitySpace => ({
  id,
  kind: 'TABLE',
  minGuests: min,
  maxGuests: max,
  seatCount: null,
  maxSeatsPerBooking: null,
  position,
});

const seats = (
  id: string,
  seatCount: number,
  maxSeatsPerBooking: number,
): AvailabilitySpace => ({
  id,
  kind: 'SEATS',
  minGuests: null,
  maxGuests: null,
  seatCount,
  maxSeatsPerBooking,
  position: 0,
});

const allWeek = (openTime = '08:00', closeTime = '23:00') =>
  ['LUNDI', 'MARDI', 'MERCREDI', 'JEUDI', 'VENDREDI', 'SAMEDI', 'DIMANCHE'].map(
    (dayOfWeek) => ({ dayOfWeek, openTime, closeTime, isClosed: false }),
  );

const ctx = (over: Partial<DayContext> = {}): DayContext => ({
  date: DATE,
  now: NOW,
  settings: {
    slotDurationMin: 90,
    slotStepMin: 30,
    bufferMin: 15,
    minLeadMin: 120,
    maxAdvanceDays: 30,
    maxPartySize: 8,
  },
  windows: [{ startTime: '12:00', endTime: '13:00' }],
  spaces: [table('t1', 1, 4)],
  occupancies: [],
  openingHours: allWeek(),
  pausedUntil: null,
  closures: [],
  closedForHoliday: false,
  ...over,
});

const at = (hhmm: string, date = DATE) => {
  const [h, m] = hhmm.split(':').map(Number);
  return arrivalInstant(date, h * 60 + m);
};

const occ = (
  spaceId: string,
  start: string,
  until: string,
  partySize = 2,
  id = `r-${spaceId}-${start}`,
): Occupancy => ({
  reservationId: id,
  spaceId,
  partySize,
  arrivalAt: at(start),
  occupiedUntil: at(until),
});

const times = (c: DayContext, party = 2) =>
  availableSlots(c, party).map((s) => s.time);

describe('dates et fuseau', () => {
  it('12:00 à Brazzaville est 11:00 UTC', () => {
    expect(at('12:00').toISOString()).toBe('2026-10-20T11:00:00.000Z');
  });

  it('00:30 à Brazzaville tombe la veille en UTC', () => {
    expect(at('00:30').toISOString()).toBe('2026-10-19T23:30:00.000Z');
  });

  it('le 20/10/2026 est un MARDI', () => {
    expect(dayOfWeekOf(DATE)).toBe('MARDI');
  });

  it('refuse les dates impossibles ou mal formées', () => {
    expect(parseIsoDate('2026-02-31')).toBeNull();
    expect(parseIsoDate('2026-2-3')).toBeNull();
    expect(parseIsoDate('demain')).toBeNull();
    expect(parseIsoDate('2026-10-20')).toEqual({ y: 2026, m: 10, d: 20 });
    expect(times(ctx({ date: '2026-13-01' }))).toEqual([]);
  });
});

describe('heures proposées', () => {
  it('au pas, fin de plage incluse', () => {
    expect(times(ctx())).toEqual(['12:00', '12:30', '13:00']);
  });

  it('fin hors du pas : dernière arrivée au pas avant la fin', () => {
    expect(
      times(ctx({ windows: [{ startTime: '12:00', endTime: '13:45' }] })),
    ).toEqual(['12:00', '12:30', '13:00', '13:30']);
  });

  it('plusieurs plages, triées', () => {
    expect(
      times(
        ctx({
          windows: [
            { startTime: '19:00', endTime: '19:30' },
            { startTime: '12:00', endTime: '12:30' },
          ],
        }),
      ),
    ).toEqual(['12:00', '12:30', '19:00', '19:30']);
  });

  it('délai minimal : une heure trop proche n’est pas proposée (borne incluse)', () => {
    // Maintenant = 10:00 locale le jour même ; délai 120 min → 12:00 admis.
    const now = at('10:00');
    expect(times(ctx({ now }))).toEqual(['12:00', '12:30', '13:00']);
    // 10:01 → 12:00 est à 119 min : refusé.
    expect(times(ctx({ now: new Date(now.getTime() + 60_000) }))).toEqual([
      '12:30',
      '13:00',
    ]);
  });

  it('horizon : au-delà de maxAdvanceDays, rien', () => {
    expect(
      times(
        ctx({
          settings: { ...ctx().settings, maxAdvanceDays: 1 },
          now: new Date('2026-10-18T09:00:00Z'),
        }),
      ),
    ).toEqual([]);
  });

  it('groupe hors bornes : rien', () => {
    expect(times(ctx(), 0)).toEqual([]);
    expect(times(ctx(), 9)).toEqual([]);
  });

  it('hors horaires d’ouverture : l’heure n’est pas proposée', () => {
    expect(times(ctx({ openingHours: allWeek('12:15', '23:00') }))).toEqual([
      '12:30',
      '13:00',
    ]);
    expect(
      times(
        ctx({
          openingHours: allWeek().map((h) =>
            h.dayOfWeek === 'MARDI' ? { ...h, isClosed: true } : h,
          ),
        }),
      ),
    ).toEqual([]);
  });

  it('jour férié fermé, congé, pause : rien pendant la fermeture', () => {
    expect(times(ctx({ closedForHoliday: true }))).toEqual([]);
    expect(
      times(
        ctx({ closures: [{ startsAt: at('12:00'), endsAt: at('12:45') }] }),
      ),
    ).toEqual(['13:00']);
    // Pause en cours (posée avant `now`) jusqu'à 12:31.
    expect(times(ctx({ now: at('09:00'), pausedUntil: at('12:31') }))).toEqual([
      '13:00',
    ]);
  });
});

describe('capacité', () => {
  it('table entière : un seul groupe, marge comprise', () => {
    // Réservation 12:00, 90 min + 15 = libre à 13:45.
    const c = ctx({
      windows: [{ startTime: '12:00', endTime: '14:00' }],
      occupancies: [occ('t1', '12:00', '13:45')],
    });
    // 12:30, 13:00 et 13:30 empiètent ; 14:00 est libre.
    expect(times(c)).toEqual(['14:00']);
  });

  it('borne exclue : une table libérée à 13:30 accepte une arrivée à 13:30', () => {
    const c = ctx({
      windows: [{ startTime: '13:30', endTime: '13:30' }],
      occupancies: [occ('t1', '11:45', '13:30')],
    });
    expect(times(c)).toEqual(['13:30']);
  });

  it('une arrivée qui déborderait sur une réservation suivante est refusée', () => {
    // Suivante à 14:00 ; arrivée 12:30 + 105 min = 14:15 > 14:00.
    const c = ctx({
      windows: [{ startTime: '12:00', endTime: '12:30' }],
      occupancies: [occ('t1', '14:00', '15:45')],
    });
    expect(times(c)).toEqual(['12:00']);
  });

  it('table trop petite ou trop grande pour le groupe', () => {
    expect(times(ctx({ spaces: [table('t1', 4, 6)] }), 2)).toEqual([]);
    expect(times(ctx({ spaces: [table('t1', 1, 2)] }), 3)).toEqual([]);
  });

  it('places : le pic compte, pas la somme de tout l’intervalle', () => {
    const space = seats('s1', 10, 6);
    // Deux groupes de 6 qui se suivent sans se croiser.
    const occupancies = [
      occ('s1', '11:00', '12:30', 6, 'a'),
      occ('s1', '12:30', '14:00', 6, 'b'),
    ];
    // Un groupe de 4 sur [12:00, 13:45) : pic = 6 → 6 + 4 = 10 ≤ 10.
    expect(isSpaceFree(space, 4, at('12:00'), at('13:45'), occupancies)).toBe(
      true,
    );
    // Un groupe de 5 : 11 > 10.
    expect(isSpaceFree(space, 5, at('12:00'), at('13:45'), occupancies)).toBe(
      false,
    );
  });

  it('places : deux groupes simultanés s’additionnent', () => {
    const space = seats('s1', 10, 6);
    const occupancies = [
      occ('s1', '12:00', '13:45', 4, 'a'),
      occ('s1', '12:30', '14:15', 4, 'b'),
    ];
    // Sur [12:00, 13:45) : pic à 12:30 = 8 → 8 + 2 = 10 ≤ 10, 8 + 3 > 10.
    expect(isSpaceFree(space, 2, at('12:00'), at('13:45'), occupancies)).toBe(
      true,
    );
    expect(isSpaceFree(space, 3, at('12:00'), at('13:45'), occupancies)).toBe(
      false,
    );
  });

  it('places : au plus maxSeatsPerBooking par réservation', () => {
    expect(times(ctx({ spaces: [seats('s1', 20, 4)] }), 5)).toEqual([]);
    expect(times(ctx({ spaces: [seats('s1', 20, 4)] }), 4)).toEqual([
      '12:00',
      '12:30',
      '13:00',
    ]);
  });

  it('attribution : la plus petite table qui convient, avant les places', () => {
    const spaces = [
      seats('s1', 20, 8),
      table('big', 1, 8),
      table('small', 1, 2),
    ];
    const settings = ctx().settings;
    expect(pickSpace(spaces, 2, at('12:00'), settings, [])?.id).toBe('small');
    expect(pickSpace(spaces, 5, at('12:00'), settings, [])?.id).toBe('big');
    // Tables prises : l'espace de places prend le relais.
    const taken = [
      occ('small', '12:00', '13:45'),
      occ('big', '12:00', '13:45'),
    ];
    expect(pickSpace(spaces, 2, at('12:00'), settings, taken)?.id).toBe('s1');
  });

  it('réattribution : la réservation déplacée ne se bloque pas elle-même', () => {
    const settings = ctx().settings;
    const self = occ('t1', '12:00', '13:45', 2, 'moi');
    expect(
      pickSpace([table('t1', 1, 4)], 2, at('12:00'), settings, [self]),
    ).toBeNull();
    expect(
      pickSpace([table('t1', 1, 4)], 2, at('12:00'), settings, [self], {
        excludeReservationId: 'moi',
      })?.id,
    ).toBe('t1');
  });

  it('réattribution : filtrée par type', () => {
    const settings = ctx().settings;
    expect(
      pickSpace(
        [table('t1', 1, 4), seats('s1', 10, 4)],
        2,
        at('12:00'),
        settings,
        [],
        { kind: 'SEATS' },
      )?.id,
    ).toBe('s1');
  });
});
