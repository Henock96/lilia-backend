import {
  brazzavilleClock,
  datedClosureAt,
  decideOpening,
  nextOpeningAt,
  OpeningHorizon,
  OpeningInput,
  openingCandidates,
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

describe('nextOpeningAt', () => {
  const NONE: OpeningHorizon = { holidays: new Set(), closures: [] };
  const WEEK = [
    'LUNDI',
    'MARDI',
    'MERCREDI',
    'JEUDI',
    'VENDREDI',
    'SAMEDI',
    'DIMANCHE',
  ].map((dayOfWeek) => ({
    dayOfWeek,
    openTime: '10:00',
    closeTime: '22:00',
    isClosed: false,
  }));
  const TUESDAY = '2026-09-29';
  const WEDNESDAY = '2026-09-30';

  /** La règle elle-même, à un instant quelconque de l'horizon. */
  function openAt(i: OpeningInput, h: OpeningHorizon, t: Date): boolean {
    return decideOpening({
      ...i,
      now: t,
      isHoliday: h.holidays.has(brazzavilleClock(t).isoDate),
      closures: h.closures,
    }).open;
  }

  /**
   * Propriété transversale : le résultat est ouvert selon `decideOpening`, et
   * aucune minute entre `now` et lui ne l'est (balayage exhaustif, 8 jours).
   */
  function expectConsistent(i: OpeningInput, h: OpeningHorizon = NONE) {
    const result = nextOpeningAt(i, h);
    const end = result ?? new Date(i.now.getTime() + 8 * 24 * 3600_000);
    if (result) expect(openAt(i, h, result)).toBe(true);
    const firstMinute = Math.floor(i.now.getTime() / 60_000) * 60_000 + 60_000;
    for (let t = firstMinute; t < end.getTime(); t += 60_000) {
      if (openAt(i, h, new Date(t))) {
        throw new Error(`ouvert dès ${new Date(t).toISOString()}`);
      }
    }
    return result;
  }

  it('ouvert maintenant : null', () => {
    expect(nextOpeningAt(input({ hours: WEEK }), NONE)).toBeNull();
  });

  it('avant l’ouverture du jour : aujourd’hui 10:00', () => {
    expect(expectConsistent(input({ hours: WEEK, now: at('07:00') }))).toEqual(
      at('10:00'),
    );
  });

  it('après la fermeture : demain 10:00', () => {
    expect(expectConsistent(input({ hours: WEEK, now: at('23:00') }))).toEqual(
      at('10:00', TUESDAY),
    );
  });

  it('créneau de nuit (20:00 → 02:00), il est 03:00 : aujourd’hui 20:00', () => {
    const night = WEEK.map((h) => ({
      ...h,
      openTime: '20:00',
      closeTime: '02:00',
    }));
    expect(expectConsistent(input({ hours: night, now: at('03:00') }))).toEqual(
      at('20:00'),
    );
  });

  it('jour fermé : le lendemain à l’heure d’ouverture', () => {
    const tuesdayClosed = WEEK.map((h) =>
      h.dayOfWeek === 'MARDI' ? { ...h, isClosed: true } : h,
    );
    expect(
      expectConsistent(input({ hours: tuesdayClosed, now: at('23:00') })),
    ).toEqual(at('10:00', WEDNESDAY));
  });

  it('pause dans les horaires : la fin de la pause', () => {
    expect(
      expectConsistent(input({ hours: WEEK, pausedUntil: at('14:30') })),
    ).toEqual(at('14:30'));
  });

  it('pause au-delà de la fermeture : l’ouverture du lendemain', () => {
    expect(
      expectConsistent(
        input({ hours: WEEK, now: at('21:00'), pausedUntil: at('23:00') }),
      ),
    ).toEqual(at('10:00', TUESDAY));
  });

  it('fermeture exceptionnelle (congé de 3 jours) : première ouverture après', () => {
    const closure = {
      startsAt: at('00:00'),
      endsAt: at('00:00', '2026-10-01'),
    };
    const horizon = { holidays: new Set<string>(), closures: [closure] };
    expect(
      expectConsistent(input({ hours: WEEK, closures: [closure] }), horizon),
    ).toEqual(at('10:00', '2026-10-01'));
  });

  it('congé qui finit en pleine journée : l’heure de fin du congé', () => {
    const closure = { startsAt: at('00:00'), endsAt: at('15:00') };
    const horizon = { holidays: new Set<string>(), closures: [closure] };
    expect(
      expectConsistent(input({ hours: WEEK, closures: [closure] }), horizon),
    ).toEqual(at('15:00'));
  });

  it('férié demain + closedOnHolidays : le surlendemain', () => {
    const horizon = { holidays: new Set([TUESDAY]), closures: [] };
    expect(
      expectConsistent(input({ hours: WEEK, now: at('23:00') }), horizon),
    ).toEqual(at('10:00', WEDNESDAY));
  });

  it('férié aujourd’hui : le lendemain, pas plus tard dans la journée', () => {
    const horizon = { holidays: new Set([MONDAY]), closures: [] };
    expect(
      expectConsistent(input({ hours: WEEK, isHoliday: true }), horizon),
    ).toEqual(at('10:00', TUESDAY));
  });

  it('férié qui se termine pendant un créneau de nuit : minuit', () => {
    const night = WEEK.map((h) => ({
      ...h,
      openTime: '20:00',
      closeTime: '02:00',
    }));
    const horizon = { holidays: new Set([MONDAY]), closures: [] };
    expect(
      expectConsistent(
        input({ hours: night, now: at('21:00'), isHoliday: true }),
        horizon,
      ),
    ).toEqual(at('00:00', TUESDAY));
  });

  it('férié + closedOnHolidays = false : férié ignoré', () => {
    const horizon = { holidays: new Set([TUESDAY]), closures: [] };
    expect(
      expectConsistent(
        input({ hours: WEEK, now: at('23:00'), closedOnHolidays: false }),
        horizon,
      ),
    ).toEqual(at('10:00', TUESDAY));
  });

  it('fermé à la main (manualOverride) : null, jamais une heure devinée', () => {
    expect(
      nextOpeningAt(
        input({ hours: WEEK, manualOverride: true, currentIsOpen: false }),
        NONE,
      ),
    ).toBeNull();
  });

  it('ouvert à la main mais en pause : la fin de la pause', () => {
    expect(
      expectConsistent(
        input({
          hours: [],
          manualOverride: true,
          currentIsOpen: true,
          pausedUntil: at('13:00'),
        }),
      ),
    ).toEqual(at('13:00'));
  });

  it('aucun horaire : null', () => {
    expect(expectConsistent(input({ hours: [], now: at('23:00') }))).toBeNull();
  });

  it('fuseau : 23:30 UTC dimanche = 00:30 lundi à Brazzaville', () => {
    const mondayOnly = [
      {
        dayOfWeek: 'LUNDI',
        openTime: '10:00',
        closeTime: '22:00',
        isClosed: false,
      },
    ];
    expect(
      expectConsistent(
        input({ hours: mondayOnly, now: new Date('2026-09-27T23:30:00.000Z') }),
      ),
    ).toEqual(new Date('2026-09-28T09:00:00.000Z'));
  });

  it('plusieurs créneaux (nuit de la veille + jour) : le plus proche', () => {
    // Une ligne par jour (@@unique restaurantId+dayOfWeek) : dimanche 20:00 →
    // 02:00 déborde sur lundi, qui ouvre ensuite à 08:00.
    expect(expectConsistent(input({ now: at('03:00') }))).toEqual(at('08:00'));
    expect(
      nextOpeningAt(input({ now: at('23:00', '2026-09-27') }), NONE),
    ).toBeNull(); // dimanche 23:00 : ouvert (dimanche 20:00 → 02:00)
  });

  it('aucune ouverture dans l’horizon de 8 jours : null', () => {
    const closure = {
      startsAt: at('00:00'),
      endsAt: at('00:00', '2026-10-20'),
    };
    const horizon = { holidays: new Set<string>(), closures: [closure] };
    expect(
      expectConsistent(input({ hours: WEEK, closures: [closure] }), horizon),
    ).toBeNull();
  });

  it('les candidats sont triés, uniques et postérieurs à maintenant', () => {
    const c = openingCandidates(
      { now: at('12:00'), hours: WEEK, pausedUntil: at('10:00') },
      NONE,
    );
    expect(c.every((t) => t > at('12:00'))).toBe(true);
    expect(c.map(Number)).toEqual(
      [...new Set(c.map(Number))].sort((a, b) => a - b),
    );
    expect(c[0]).toEqual(at('10:00', TUESDAY));
  });
});
