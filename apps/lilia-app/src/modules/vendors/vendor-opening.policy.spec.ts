import {
  brazzavilleClock,
  datedClosureAt,
  decideOpening,
  OpeningInput,
} from './vendor-opening.policy';

/**
 * Règle d'ouverture (F3-03, R-03.1). Les heures sont écrites en heure de
 * Brazzaville (UTC+1) : `at('LUNDI 12:00')` = lundi 28/09/2026 11:00 UTC.
 */
const MONDAY = '2026-09-28'; // un lundi
function at(localHHMM: string, isoDate = MONDAY): Date {
  return new Date(
    new Date(`${isoDate}T${localHHMM}:00.000Z`).getTime() - 3600_000,
  );
}

const HOURS = [
  {
    dayOfWeek: 'LUNDI',
    openTime: '08:00',
    closeTime: '22:00',
    isClosed: false,
  },
  {
    dayOfWeek: 'DIMANCHE',
    openTime: '20:00',
    closeTime: '02:00',
    isClosed: false,
  },
];

function input(overrides: Partial<OpeningInput> = {}): OpeningInput {
  return {
    now: at('12:00'),
    hours: HOURS,
    manualOverride: false,
    currentIsOpen: false,
    pausedUntil: null,
    closures: [],
    isHoliday: false,
    closedOnHolidays: true,
    ...overrides,
  };
}

describe('brazzavilleClock', () => {
  it('23:30 UTC est déjà le lendemain à Brazzaville', () => {
    const clock = brazzavilleClock(new Date('2026-09-27T23:30:00.000Z'));
    expect(clock.day).toBe('LUNDI');
    expect(clock.isoDate).toBe(MONDAY);
    expect(clock.minutes).toBe(30);
  });
});

describe('decideOpening', () => {
  it('dans les horaires : ouvert', () => {
    expect(decideOpening(input())).toEqual({
      open: true,
      reason: 'OPEN',
      until: null,
    });
  });

  it('hors horaires : fermé', () => {
    expect(decideOpening(input({ now: at('23:00') })).reason).toBe(
      'OUTSIDE_HOURS',
    );
  });

  it('traversée de minuit : lundi 01:00 ouvert par l’horaire du dimanche', () => {
    expect(decideOpening(input({ now: at('01:00') })).open).toBe(true);
  });

  it('pause en cours : fermé jusqu’à l’échéance, même dans les horaires', () => {
    const until = at('14:30');
    expect(decideOpening(input({ pausedUntil: until }))).toEqual({
      open: false,
      reason: 'PAUSED',
      until,
    });
  });

  it('pause échue : elle ne compte plus', () => {
    expect(decideOpening(input({ pausedUntil: at('11:00') })).open).toBe(true);
  });

  it('congé couvrant l’instant : fermé, fin la plus tardive annoncée', () => {
    const d = decideOpening(
      input({
        closures: [
          { startsAt: at('00:00'), endsAt: at('18:00') },
          { startsAt: at('10:00'), endsAt: at('20:00') },
          { startsAt: at('13:00'), endsAt: at('23:00') }, // pas encore commencé
        ],
      }),
    );
    expect(d).toEqual({ open: false, reason: 'CLOSURE', until: at('20:00') });
  });

  it('congé dont la fin est exactement maintenant : terminé', () => {
    expect(
      decideOpening(
        input({ closures: [{ startsAt: at('08:00'), endsAt: at('12:00') }] }),
      ).open,
    ).toBe(true);
  });

  it('jour férié : fermé si le vendeur ferme les jours fériés', () => {
    expect(decideOpening(input({ isHoliday: true })).reason).toBe('HOLIDAY');
  });

  it('jour férié : ouvert si le vendeur travaille les jours fériés', () => {
    expect(
      decideOpening(input({ isHoliday: true, closedOnHolidays: false })).open,
    ).toBe(true);
  });

  it('interrupteur manuel : l’état posé à la main, hors horaires compris', () => {
    expect(
      decideOpening(
        input({ now: at('23:30'), manualOverride: true, currentIsOpen: true }),
      ),
    ).toEqual({ open: true, reason: 'OPEN', until: null });
    expect(
      decideOpening(input({ manualOverride: true, currentIsOpen: false }))
        .reason,
    ).toBe('MANUAL');
  });

  it('une pause ferme malgré l’interrupteur manuel ouvert', () => {
    expect(
      decideOpening(
        input({
          manualOverride: true,
          currentIsOpen: true,
          pausedUntil: at('13:00'),
        }),
      ).reason,
    ).toBe('PAUSED');
  });

  it('priorité : pause > congé > férié', () => {
    expect(
      decideOpening(
        input({
          pausedUntil: at('13:00'),
          closures: [{ startsAt: at('00:00'), endsAt: at('23:00') }],
          isHoliday: true,
        }),
      ).reason,
    ).toBe('PAUSED');
    expect(
      decideOpening(
        input({
          closures: [{ startsAt: at('00:00'), endsAt: at('23:00') }],
          isHoliday: true,
        }),
      ).reason,
    ).toBe('CLOSURE');
  });

  it('jour marqué fermé : fermé', () => {
    expect(
      decideOpening(
        input({
          hours: [
            {
              dayOfWeek: 'LUNDI',
              openTime: '08:00',
              closeTime: '22:00',
              isClosed: true,
            },
          ],
        }),
      ).open,
    ).toBe(false);
  });

  it('sans horaires : fermé', () => {
    expect(decideOpening(input({ hours: [] })).open).toBe(false);
  });
});

describe('datedClosureAt (R-03.3, précommandes)', () => {
  const now = at('09:00');

  it('échéance pendant la pause', () => {
    expect(datedClosureAt(at('10:00'), at('11:00'), [], now)).toEqual({
      reason: 'PAUSED',
      until: at('11:00'),
    });
  });

  it('échéance après la pause : rien', () => {
    expect(datedClosureAt(at('12:00'), at('11:00'), [], now)).toBeNull();
  });

  it('échéance pendant un congé à venir', () => {
    const closure = {
      startsAt: at('00:00', '2026-10-01'),
      endsAt: at('00:00', '2026-10-05'),
    };
    expect(
      datedClosureAt(at('12:00', '2026-10-02'), null, [closure], now),
    ).toEqual({
      reason: 'CLOSURE',
      until: closure.endsAt,
    });
  });
});
