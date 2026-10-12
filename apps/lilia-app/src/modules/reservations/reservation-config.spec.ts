import {
  DraftSpace,
  EvaluationContext,
  evaluateReservationDraft,
  labelKeyOf,
  normalizeLabel,
  ReservationDraft,
} from './reservation-config';

/**
 * Moteur pur de la configuration de réservation (Premium Lot 3).
 * Chaque règle de `03-approval.md` a ici sa ligne écrite à la main.
 */

const table = (
  label: string,
  min = 1,
  max = 4,
  extra: Partial<DraftSpace> = {},
): DraftSpace => ({
  kind: 'TABLE',
  label,
  minGuests: min,
  maxGuests: max,
  ...extra,
});

const draft = (over: Partial<ReservationDraft> = {}): ReservationDraft => ({
  enabled: true,
  slotDurationMin: 90,
  slotStepMin: 30,
  bufferMin: 15,
  minLeadMin: 120,
  maxAdvanceDays: 30,
  maxPartySize: 4,
  spaces: [table('Table 1')],
  windows: [{ dayOfWeek: 'LUNDI', startTime: '12:00', endTime: '13:00' }],
  ...over,
});

const everyDay = (openTime: string, closeTime: string) =>
  ['LUNDI', 'MARDI', 'MERCREDI', 'JEUDI', 'VENDREDI', 'SAMEDI', 'DIMANCHE'].map(
    (dayOfWeek) => ({ dayOfWeek, openTime, closeTime, isClosed: false }),
  );

const ctx = (over: Partial<EvaluationContext> = {}): EvaluationContext => ({
  existingSpaces: [],
  openingHours: everyDay('08:00', '23:00'),
  platformEnabled: true,
  entitled: true,
  ...over,
});

const codes = (d: ReservationDraft, c: EvaluationContext = ctx()) =>
  evaluateReservationDraft(d, c).issues.map((i) => `${i.severity}:${i.code}`);

const w = (dayOfWeek: string, startTime: string, endTime: string) => ({
  dayOfWeek,
  startTime,
  endTime,
});

describe('evaluateReservationDraft', () => {
  it('accepte une configuration complète, sans constat', () => {
    const r = evaluateReservationDraft(draft(), ctx());
    expect(r.issues).toEqual([]);
    expect(r.hasErrors).toBe(false);
    expect(r.plannedSpaces).toEqual([
      expect.objectContaining({
        action: 'CREATE',
        label: 'Table 1',
        labelKey: 'table 1',
      }),
    ]);
  });

  describe('règles de créneau (D5–D10)', () => {
    it.each([
      ['slotDurationMin', 29],
      ['slotDurationMin', 241],
      ['bufferMin', -1],
      ['bufferMin', 61],
      ['minLeadMin', 29],
      ['minLeadMin', 2881],
      ['maxAdvanceDays', 0],
      ['maxAdvanceDays', 91],
      ['maxPartySize', 0],
      ['maxPartySize', 51],
      ['slotDurationMin', 90.5],
    ])('%s = %s → OUT_OF_RANGE', (field, value) => {
      const r = evaluateReservationDraft(draft({ [field]: value }), ctx());
      expect(r.issues).toContainEqual(
        expect.objectContaining({
          severity: 'ERROR',
          code: 'OUT_OF_RANGE',
          field,
        }),
      );
    });

    it('accepte les bornes exactes', () => {
      expect(
        codes(
          draft({
            slotDurationMin: 30,
            bufferMin: 0,
            minLeadMin: 2880,
            maxAdvanceDays: 90,
          }),
        ),
      ).not.toContain('ERROR:OUT_OF_RANGE');
    });

    it.each([15, 30, 60])('pas de %s min accepté', (step) => {
      expect(codes(draft({ slotStepMin: step }))).toEqual([]);
    });

    it('pas de 20 min refusé', () => {
      expect(codes(draft({ slotStepMin: 20 }))).toContain('ERROR:OUT_OF_RANGE');
    });
  });

  describe('ressources', () => {
    it('table : min > max → TABLE_GUESTS_RANGE', () => {
      expect(codes(draft({ spaces: [table('T', 5, 2)] }))).toContain(
        'ERROR:TABLE_GUESTS_RANGE',
      );
    });

    it('table de 51 personnes → TABLE_GUESTS_RANGE', () => {
      expect(codes(draft({ spaces: [table('T', 1, 51)] }))).toContain(
        'ERROR:TABLE_GUESTS_RANGE',
      );
    });

    it('espace : plus de places par réservation que de places → SEATS_RANGE', () => {
      expect(
        codes(
          draft({
            spaces: [
              {
                kind: 'SEATS',
                label: 'Comptoir',
                seatCount: 4,
                maxSeatsPerBooking: 6,
              },
            ],
          }),
        ),
      ).toContain('ERROR:SEATS_RANGE');
    });

    it('espace de places valide : accueille les groupes jusqu’à son plafond', () => {
      const r = evaluateReservationDraft(
        draft({
          maxPartySize: 3,
          spaces: [
            {
              kind: 'SEATS',
              label: 'Comptoir',
              seatCount: 8,
              maxSeatsPerBooking: 3,
            },
          ],
        }),
        ctx(),
      );
      expect(r.issues).toEqual([]);
      expect(r.preview.capacity).toEqual({
        tables: 0,
        tableCovers: 0,
        seatSpaces: 1,
        seats: 8,
        totalCovers: 8,
      });
    });

    it('les champs de l’autre type sont ignorés (une table ne garde pas de seatCount)', () => {
      const r = evaluateReservationDraft(
        draft({
          spaces: [table('T', 1, 4, { seatCount: 9, maxSeatsPerBooking: 9 })],
        }),
        ctx(),
      );
      expect(r.plannedSpaces[0]).toMatchObject({
        seatCount: null,
        maxSeatsPerBooking: null,
      });
    });

    it('libellé vide ou > 40 caractères → LABEL_LENGTH', () => {
      expect(codes(draft({ spaces: [table('   ')] }))).toContain(
        'ERROR:LABEL_LENGTH',
      );
      expect(codes(draft({ spaces: [table('x'.repeat(41))] }))).toContain(
        'ERROR:LABEL_LENGTH',
      );
      expect(codes(draft({ spaces: [table('x'.repeat(40))] }))).toEqual([]);
    });

    it('Q4 : doublon à la casse et aux espaces près, accents significatifs', () => {
      expect(
        codes(draft({ spaces: [table('Table 1'), table('  table   1 ')] })),
      ).toContain('ERROR:DUPLICATE_LABEL');
      expect(codes(draft({ spaces: [table('Été'), table('Ete')] }))).toEqual(
        [],
      );
      expect(labelKeyOf('Terrasse')).toBe(labelKeyOf('terrasse'));
      expect(normalizeLabel('  Salle   du   fond ')).toBe('Salle du fond');
    });

    it('NFC : un « é » composé et décomposé sont le même libellé', () => {
      expect(
        codes(draft({ spaces: [table('Caf\u00e9'), table('Cafe\u0301')] })),
      ).toContain('ERROR:DUPLICATE_LABEL');
    });

    it('limites de volume (D15)', () => {
      const tables = Array.from({ length: 51 }, (_, i) => table(`T${i}`));
      expect(codes(draft({ spaces: tables }))).toContain(
        'ERROR:LIMIT_EXCEEDED',
      );
      const seats = Array.from({ length: 6 }, (_, i) => ({
        kind: 'SEATS',
        label: `S${i}`,
        seatCount: 2,
        maxSeatsPerBooking: 2,
      }));
      expect(codes(draft({ spaces: seats }))).toContain('ERROR:LIMIT_EXCEEDED');
      const big = [
        { kind: 'SEATS', label: 'A', seatCount: 150, maxSeatsPerBooking: 4 },
        { kind: 'SEATS', label: 'B', seatCount: 51, maxSeatsPerBooking: 4 },
      ];
      expect(codes(draft({ spaces: big }))).toContain('ERROR:LIMIT_EXCEEDED');
    });
  });

  describe('identifiants et archivage (Q1, §12.1)', () => {
    const existing = [
      { id: 's1', kind: 'TABLE', label: 'Table 1', archivedAt: null },
      {
        id: 's2',
        kind: 'TABLE',
        label: 'Vieille table',
        archivedAt: new Date('2026-10-01'),
      },
    ];

    it('id inconnu (ou d’une autre boutique) → UNKNOWN_RESOURCE_ID', () => {
      expect(
        codes(
          draft({ spaces: [table('Table 1', 1, 4, { id: 'autre' })] }),
          ctx({ existingSpaces: [] }),
        ),
      ).toContain('ERROR:UNKNOWN_RESOURCE_ID');
    });

    it('ressource active omise → MISSING_RESOURCE, jamais d’archivage implicite', () => {
      const r = evaluateReservationDraft(
        draft({ spaces: [table('Autre')] }),
        ctx({ existingSpaces: existing }),
      );
      expect(r.issues).toContainEqual(
        expect.objectContaining({
          code: 'MISSING_RESOURCE',
          severity: 'ERROR',
        }),
      );
      expect(r.plannedSpaces.some((s) => s.action === 'ARCHIVE')).toBe(false);
    });

    it('ressource déjà archivée : peut être omise', () => {
      expect(
        codes(
          draft({ spaces: [table('Table 1', 1, 4, { id: 's1' })] }),
          ctx({ existingSpaces: existing }),
        ),
      ).toEqual([]);
    });

    it('archivage explicite : la ressource sort de la capacité et libère son libellé', () => {
      const r = evaluateReservationDraft(
        draft({
          spaces: [
            table('Table 1', 1, 4, { id: 's1', archived: true }),
            table('Table 1'),
          ],
        }),
        ctx({ existingSpaces: existing }),
      );
      expect(r.issues).toEqual([]);
      expect(r.plannedSpaces.map((s) => s.action)).toEqual([
        'ARCHIVE',
        'CREATE',
      ]);
      expect(r.preview.capacity.tables).toBe(1);
    });

    it('modifier une ressource archivée → RESOURCE_ARCHIVED (pas de désarchivage)', () => {
      expect(
        codes(
          draft({
            spaces: [
              table('Table 1', 1, 4, { id: 's1' }),
              table('Vieille table', 1, 4, { id: 's2' }),
            ],
          }),
          ctx({ existingSpaces: existing }),
        ),
      ).toContain('ERROR:RESOURCE_ARCHIVED');
    });

    // Type figé en v1 : une table ne devient pas un espace de places (ni
    // l'inverse) sous le même identifiant — on archive, puis on recrée.
    it.each([
      [
        'TABLE → SEATS',
        {
          kind: 'SEATS',
          label: 'Table 1',
          seatCount: 4,
          maxSeatsPerBooking: 4,
          id: 's1',
        },
      ],
      [
        'SEATS → TABLE',
        {
          kind: 'TABLE',
          label: 'Comptoir',
          minGuests: 1,
          maxGuests: 4,
          id: 'c1',
        },
      ],
    ] as const)(
      'changement de type %s → RESOURCE_KIND_CHANGED, aucune écriture prévue',
      (_, space) => {
        const r = evaluateReservationDraft(
          draft({ spaces: [{ ...space }] }),
          ctx({
            existingSpaces: [
              { id: 's1', kind: 'TABLE', label: 'Table 1', archivedAt: null },
              { id: 'c1', kind: 'SEATS', label: 'Comptoir', archivedAt: null },
            ].filter((e) => e.id === space.id),
          }),
        );
        expect(r.issues).toContainEqual(
          expect.objectContaining({
            severity: 'ERROR',
            code: 'RESOURCE_KIND_CHANGED',
            field: 'spaces[0].kind',
          }),
        );
        expect(r.hasErrors).toBe(true);
        expect(r.plannedSpaces.some((s) => s.action === 'UPDATE')).toBe(false);
      },
    );

    it('changement de type d’une ressource archivée → RESOURCE_KIND_CHANGED', () => {
      expect(
        codes(
          draft({
            spaces: [
              table('Table 1', 1, 4, { id: 's1' }),
              {
                id: 's2',
                kind: 'SEATS',
                label: 'Vieille table',
                seatCount: 4,
                maxSeatsPerBooking: 2,
                archived: true,
              },
            ],
          }),
          ctx({ existingSpaces: existing }),
        ),
      ).toContain('ERROR:RESOURCE_KIND_CHANGED');
    });

    it('conversion par archivage explicite + nouvelle ressource : acceptée', () => {
      const r = evaluateReservationDraft(
        draft({
          spaces: [
            table('Table 1', 1, 4, { id: 's1', archived: true }),
            {
              kind: 'SEATS',
              label: 'Table 1',
              seatCount: 6,
              maxSeatsPerBooking: 4,
            },
          ],
        }),
        ctx({ existingSpaces: existing }),
      );
      expect(r.issues).toEqual([]);
      expect(r.plannedSpaces.map((s) => [s.action, s.id, s.kind])).toEqual([
        ['ARCHIVE', 's1', 'TABLE'],
        ['CREATE', null, 'SEATS'],
      ]);
    });

    it('conversion par omission : toujours MISSING_RESOURCE, jamais d’archivage', () => {
      const r = evaluateReservationDraft(
        draft({
          spaces: [
            {
              kind: 'SEATS',
              label: 'Table 1',
              seatCount: 6,
              maxSeatsPerBooking: 4,
            },
          ],
        }),
        ctx({ existingSpaces: existing }),
      );
      expect(r.issues.map((i) => i.code)).toContain('MISSING_RESOURCE');
      expect(r.plannedSpaces.some((s) => s.action === 'ARCHIVE')).toBe(false);
    });

    it('nouvelle ressource envoyée archivée → ARCHIVED_ON_CREATE', () => {
      expect(
        codes(
          draft({ spaces: [table('T', 1, 4, { archived: true }), table('U')] }),
        ),
      ).toContain('ERROR:ARCHIVED_ON_CREATE');
    });

    it('même id deux fois → DUPLICATE_RESOURCE_ID', () => {
      expect(
        codes(
          draft({
            spaces: [
              table('A', 1, 4, { id: 's1' }),
              table('B', 1, 4, { id: 's1' }),
            ],
          }),
          ctx({ existingSpaces: existing }),
        ),
      ).toContain('ERROR:DUPLICATE_RESOURCE_ID');
    });

    it('échange de libellés entre deux ressources existantes : accepté', () => {
      const two = [
        { id: 'a', kind: 'TABLE', label: 'Table 1', archivedAt: null },
        { id: 'b', kind: 'TABLE', label: 'Table 2', archivedAt: null },
      ];
      expect(
        codes(
          draft({
            spaces: [
              table('Table 2', 1, 4, { id: 'a' }),
              table('Table 1', 1, 4, { id: 'b' }),
            ],
          }),
          ctx({ existingSpaces: two }),
        ),
      ).toEqual([]);
    });
  });

  describe('plages (D3)', () => {
    it('format d’heure invalide → TIME_FORMAT', () => {
      expect(
        codes(draft({ windows: [w('LUNDI', '12h00', '13:00')] })),
      ).toContain('ERROR:TIME_FORMAT');
      expect(
        codes(draft({ windows: [w('LUNDI', '24:00', '13:00')] })),
      ).toContain('ERROR:TIME_FORMAT');
    });

    it('pas de plage de nuit : début ≥ fin → WINDOW_EMPTY', () => {
      expect(
        codes(draft({ windows: [w('LUNDI', '22:00', '01:00')] })),
      ).toContain('ERROR:WINDOW_EMPTY');
      expect(
        codes(draft({ windows: [w('LUNDI', '12:00', '12:00')] })),
      ).toContain('ERROR:WINDOW_EMPTY');
    });

    it('aucune durée minimale de plage (WINDOW_TOO_SHORT supprimé)', () => {
      expect(codes(draft({ windows: [w('LUNDI', '12:00', '12:15')] }))).toEqual(
        [],
      );
    });

    it('une longue plage qui en couvre deux autres : chacune est signalée', () => {
      const r = evaluateReservationDraft(
        draft({
          windows: [
            w('LUNDI', '10:00', '20:00'),
            w('LUNDI', '11:00', '12:00'),
            w('LUNDI', '13:00', '14:00'),
          ],
        }),
        ctx(),
      );
      expect(
        r.issues.filter((i) => i.code === 'WINDOW_OVERLAP').map((i) => i.field),
      ).toEqual(['windows[1].startTime', 'windows[2].startTime']);
    });

    it('plages qui se touchent (fin incluse) → WINDOW_OVERLAP', () => {
      expect(
        codes(
          draft({
            windows: [
              w('LUNDI', '12:00', '14:00'),
              w('LUNDI', '14:00', '15:00'),
            ],
          }),
        ),
      ).toContain('ERROR:WINDOW_OVERLAP');
      expect(
        codes(
          draft({
            windows: [
              w('LUNDI', '12:00', '14:00'),
              w('LUNDI', '14:30', '15:00'),
            ],
          }),
        ),
      ).toEqual([]);
    });

    it('4 plages le même jour → TOO_MANY_WINDOWS', () => {
      expect(
        codes(
          draft({
            windows: [
              w('LUNDI', '08:00', '09:00'),
              w('LUNDI', '10:00', '11:00'),
              w('LUNDI', '12:00', '13:00'),
              w('LUNDI', '14:00', '15:00'),
            ],
          }),
        ),
      ).toContain('ERROR:TOO_MANY_WINDOWS');
    });

    it('jour inconnu → OUT_OF_RANGE', () => {
      expect(
        codes(draft({ windows: [w('FUNDAY', '12:00', '13:00')] })),
      ).toContain('ERROR:OUT_OF_RANGE');
    });
  });

  describe('configuration activée ou brouillon', () => {
    it('activée sans ressource → NO_RESOURCE ; sans plage → NO_WINDOW', () => {
      expect(codes(draft({ spaces: [] }))).toContain('ERROR:NO_RESOURCE');
      expect(codes(draft({ windows: [] }))).toContain('ERROR:NO_WINDOW');
    });

    it('désactivée et incomplète : acceptée (brouillon)', () => {
      const r = evaluateReservationDraft(
        draft({ enabled: false, spaces: [], windows: [], maxPartySize: 50 }),
        ctx(),
      );
      expect(r.hasErrors).toBe(false);
    });
  });

  describe('tailles de groupe (D10, Q2)', () => {
    it('groupe max inatteignable, activé → PARTY_SIZE_UNREACHABLE', () => {
      expect(codes(draft({ maxPartySize: 8 }))).toContain(
        'ERROR:PARTY_SIZE_UNREACHABLE',
      );
    });

    it('désactivé : seulement l’alerte', () => {
      const c = codes(draft({ enabled: false, maxPartySize: 8 }));
      expect(c).not.toContain('ERROR:PARTY_SIZE_UNREACHABLE');
      expect(c).toContain('WARNING:PARTY_SIZES_UNCOVERED');
    });

    it('tables 2–2 et 6–8, groupe max 8 → alerte [1, 3, 4, 5]', () => {
      const r = evaluateReservationDraft(
        draft({
          maxPartySize: 8,
          spaces: [table('A', 2, 2), table('B', 6, 8)],
        }),
        ctx(),
      );
      const issue = r.issues.find((i) => i.code === 'PARTY_SIZES_UNCOVERED');
      expect(issue).toMatchObject({
        severity: 'WARNING',
        partySizes: [1, 3, 4, 5],
      });
      expect(r.hasErrors).toBe(false);
    });
  });

  describe('horaires d’ouverture (D4, Q3) — jamais bloquants', () => {
    it('plage entièrement hors horaires → OUTSIDE_OPENING_HOURS', () => {
      const r = evaluateReservationDraft(
        draft({ windows: [w('LUNDI', '05:00', '06:00')] }),
        ctx(),
      );
      expect(r.hasErrors).toBe(false);
      expect(r.issues.map((i) => i.code)).toContain('OUTSIDE_OPENING_HOURS');
    });

    it('plage partiellement hors horaires → OUTSIDE_OPENING_HOURS, créneaux marqués', () => {
      const r = evaluateReservationDraft(
        draft({ windows: [w('LUNDI', '07:00', '08:30')] }),
        ctx(),
      );
      expect(r.issues.map((i) => i.code)).toEqual(['OUTSIDE_OPENING_HOURS']);
      expect(r.preview.days[0].slots).toEqual([
        { time: '07:00', inOpeningHours: false, occupationPastClosing: false },
        { time: '07:30', inOpeningHours: false, occupationPastClosing: false },
        { time: '08:00', inOpeningHours: true, occupationPastClosing: false },
        { time: '08:30', inOpeningHours: true, occupationPastClosing: false },
      ]);
    });

    it('jour fermé → DAY_CLOSED', () => {
      const hours = everyDay('08:00', '23:00').map((h) =>
        h.dayOfWeek === 'LUNDI' ? { ...h, isClosed: true } : h,
      );
      const r = evaluateReservationDraft(draft(), ctx({ openingHours: hours }));
      expect(r.issues.map((i) => i.code)).toEqual(['DAY_CLOSED']);
      expect(r.hasErrors).toBe(false);
    });

    it('aucun horaire renseigné → DAY_CLOSED', () => {
      expect(codes(draft(), ctx({ openingHours: [] }))).toEqual([
        'WARNING:DAY_CLOSED',
      ]);
    });

    it('Q3 : dernière arrivée 22:00 + 90 min > fermeture 23:00 → OCCUPATION_PAST_CLOSING', () => {
      const r = evaluateReservationDraft(
        draft({ windows: [w('LUNDI', '21:00', '22:00')] }),
        ctx(),
      );
      expect(r.issues.map((i) => i.code)).toEqual(['OCCUPATION_PAST_CLOSING']);
      expect(
        r.preview.days[0].slots.map((s) => s.occupationPastClosing),
      ).toEqual([
        false, // 21:00 + 90 = 22:30
        false, // 21:30 + 90 = 23:00 : fermeture exacte, l'occupation finit à temps
        true, // 22:00 + 90 = 23:30
      ]);
    });

    it('§12.2 : la marge n’entre pas dans l’occupation', () => {
      // 21:30 + 90 min = 23:00 pile : à temps, même avec 60 min de marge.
      const r = evaluateReservationDraft(
        draft({ bufferMin: 60, windows: [w('LUNDI', '21:00', '21:30')] }),
        ctx(),
      );
      expect(r.issues).toEqual([]);
    });

    it('horaire de nuit (20:00 → 02:00) : une arrivée à 23:30 est dans les horaires', () => {
      const r = evaluateReservationDraft(
        draft({ windows: [w('VENDREDI', '22:00', '23:30')] }),
        ctx({ openingHours: everyDay('20:00', '02:00') }),
      );
      expect(r.issues).toEqual([]);
    });

    it('débordement de nuit : samedi 00:30–01:00 couvert par vendredi 20:00 → 02:00', () => {
      const hours = [
        {
          dayOfWeek: 'VENDREDI',
          openTime: '20:00',
          closeTime: '02:00',
          isClosed: false,
        },
      ];
      const r = evaluateReservationDraft(
        draft({ windows: [w('SAMEDI', '00:30', '01:00')] }),
        ctx({ openingHours: hours }),
      );
      // 01:00 + 90 min = 02:30 > 02:00 : seule l'occupation déborde.
      expect(r.issues.map((i) => i.code)).toEqual(['OCCUPATION_PAST_CLOSING']);
      const samedi = r.preview.days.find((d) => d.dayOfWeek === 'SAMEDI')!;
      expect(samedi.opening).toBeNull();
      expect(samedi.slots.every((s) => s.inOpeningHours)).toBe(true);
    });

    it('débordement du dimanche soir : atteint le lundi', () => {
      const hours = [
        {
          dayOfWeek: 'DIMANCHE',
          openTime: '20:00',
          closeTime: '02:00',
          isClosed: false,
        },
      ];
      const r = evaluateReservationDraft(
        draft({ slotDurationMin: 30, windows: [w('LUNDI', '00:00', '01:00')] }),
        ctx({ openingHours: hours }),
      );
      expect(r.issues).toEqual([]);
    });
  });

  describe('aperçu', () => {
    it('dernière arrivée incluse ; écart non multiple du pas', () => {
      const a = evaluateReservationDraft(
        draft({ windows: [w('MARDI', '12:00', '14:00')] }),
        ctx(),
      );
      expect(a.preview.days[1].slots.map((s) => s.time)).toEqual([
        '12:00',
        '12:30',
        '13:00',
        '13:30',
        '14:00',
      ]);
      const b = evaluateReservationDraft(
        draft({ windows: [w('MARDI', '12:00', '13:45')] }),
        ctx(),
      );
      expect(b.preview.days[1].slots.map((s) => s.time).pop()).toBe('13:30');
    });

    it('7 jours, du lundi au dimanche, capacité calculée', () => {
      const r = evaluateReservationDraft(
        draft({
          maxPartySize: 6,
          spaces: [
            table('A', 2, 4),
            table('B', 4, 6),
            {
              kind: 'SEATS',
              label: 'Bar',
              seatCount: 10,
              maxSeatsPerBooking: 2,
            },
          ],
        }),
        ctx(),
      );
      expect(r.preview.days.map((d) => d.dayOfWeek)).toEqual([
        'LUNDI',
        'MARDI',
        'MERCREDI',
        'JEUDI',
        'VENDREDI',
        'SAMEDI',
        'DIMANCHE',
      ]);
      expect(r.preview.capacity).toEqual({
        tables: 2,
        tableCovers: 10,
        seatSpaces: 1,
        seats: 10,
        totalCovers: 20,
      });
    });

    it('interrupteur éteint et droit absent : alertes, jamais d’erreur', () => {
      const r = evaluateReservationDraft(
        draft(),
        ctx({ platformEnabled: false, entitled: false }),
      );
      expect(r.issues.map((i) => `${i.severity}:${i.code}`)).toEqual([
        'WARNING:PLATFORM_DISABLED',
        'WARNING:NOT_ENTITLED',
      ]);
      expect(r.hasErrors).toBe(false);
    });
  });
});
