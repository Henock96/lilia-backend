import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '@prisma/client';

import { ReservationSettingsService } from '../../apps/lilia-app/src/modules/reservations/reservation-settings.service';
import { VendorSubscriptionService } from '../../apps/lilia-app/src/modules/subscriptions/vendor-subscription.service';

/**
 * Premium (Lot 3) — configuration de la réservation sur place, PostgreSQL réel.
 *
 * Ce qu'un mock ne peut pas montrer :
 *  · le droit Premium relu SOUS le verrou `Restaurant` : une révocation qui
 *    tient le verrou est vue par l'enregistrement qui l'attend ;
 *  · deux enregistrements simultanés sur la même version : un seul passe ;
 *  · aucune écriture partielle quand la validation refuse ;
 *  · les CHECK et l'index unique partiel de la migration, en base.
 */
const DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

const NOW = new Date('2026-10-12T10:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

describeIfDb('Réservation sur place — configuration (PostgreSQL réel)', () => {
  let prisma: PrismaClient;
  let service: ReservationSettingsService;
  let platformEnabled = false;

  beforeAll(async () => {
    prisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: DATABASE_URL }),
    });
    await prisma.$connect();
    const settings = {
      getSettings: async () => ({
        reservationsEnabled: platformEnabled,
        premiumMonthlyPriceXaf: 15000,
      }),
    };
    service = new ReservationSettingsService(
      prisma as never,
      new VendorSubscriptionService(prisma as never, settings as never),
      settings as never,
    );
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    platformEnabled = false;
    await prisma.$executeRawUnsafe(`
      TRUNCATE TABLE "ReservationWindow", "ReservationSpace",
        "ReservationSettings", "VendorSubscription", "OperatingHours",
        "User", "Restaurant"
      RESTART IDENTITY CASCADE
    `);
    const vendors: Array<[number, 'RESTAURANT' | 'HOME_COOK']> = [
      [1, 'RESTAURANT'],
      [2, 'RESTAURANT'],
      [3, 'HOME_COOK'],
    ];
    for (const [n, vendorType] of vendors) {
      await prisma.user.create({
        data: {
          id: `rv-o${n}`,
          firebaseUid: `fb-rv-o${n}`,
          email: `rv-o${n}@t.local`,
          role: 'RESTAURATEUR',
        },
      });
      // `onboardingStatus` par défaut = DRAFT : la configuration est permise
      // avant l'activation (Q5).
      await prisma.restaurant.create({
        data: {
          id: `rv-v${n}`,
          nom: `Vendeur ${n}`,
          adresse: 'Poto-Poto',
          phone: `06000008${n}`,
          ownerId: `rv-o${n}`,
          vendorType,
        },
      });
      await prisma.operatingHours.createMany({
        data: (
          [
            'LUNDI',
            'MARDI',
            'MERCREDI',
            'JEUDI',
            'VENDREDI',
            'SAMEDI',
            'DIMANCHE',
          ] as const
        ).map((dayOfWeek) => ({
          restaurantId: `rv-v${n}`,
          dayOfWeek,
          openTime: '08:00',
          closeTime: '23:00',
        })),
      });
    }
    await prisma.user.create({
      data: {
        id: 'rv-sans-boutique',
        firebaseUid: 'fb-rv-sans',
        email: 'rv-sans@t.local',
        role: 'RESTAURATEUR',
      },
    });
  });

  /** Une période Premium — ACTIVE en cours par défaut. */
  const premium = (
    restaurantId: string,
    over: Partial<{ startsAt: Date; endsAt: Date; status: string }> = {},
  ) =>
    prisma.vendorSubscription.create({
      data: {
        restaurantId,
        plan: 'PREMIUM',
        status: over.status ?? 'ACTIVE',
        startsAt: over.startsAt ?? new Date(NOW.getTime() - DAY),
        endsAt: over.endsAt ?? new Date(NOW.getTime() + 29 * DAY),
        priceXaf: 15000,
        paymentMethod: 'CASH',
        requestKey: `k-${restaurantId}-${Math.random()}`,
        grantedById: 'admin-test',
        ...(over.status === 'REVOKED'
          ? {
              revokedAt: NOW,
              revokedById: 'admin-test',
              revokeReason: 'test',
            }
          : {}),
      },
    });

  const body = (over: Record<string, unknown> = {}) => ({
    version: 0,
    enabled: true,
    slotDurationMin: 90,
    slotStepMin: 30,
    bufferMin: 15,
    minLeadMin: 120,
    maxAdvanceDays: 30,
    maxPartySize: 4,
    spaces: [
      { kind: 'TABLE' as const, label: 'Table 1', minGuests: 1, maxGuests: 4 },
      {
        kind: 'SEATS' as const,
        label: 'Comptoir',
        seatCount: 6,
        maxSeatsPerBooking: 2,
      },
    ],
    windows: [
      { dayOfWeek: 'LUNDI', startTime: '12:00', endTime: '14:00' },
      { dayOfWeek: 'LUNDI', startTime: '19:00', endTime: '21:00' },
    ],
    ...over,
  });

  const save = (owner: string, over: Record<string, unknown> = {}) =>
    service.save(owner, body(over) as never, NOW);

  const counts = async () => ({
    settings: await prisma.reservationSettings.count(),
    spaces: await prisma.reservationSpace.count(),
    windows: await prisma.reservationWindow.count(),
  });

  describe('droits', () => {
    it('Premium actif : enregistre, version 1, état serveur complet', async () => {
      await premium('rv-v1');
      const state = await save('rv-o1');
      expect(state).toMatchObject({
        eligible: true,
        configured: true,
        enabled: true,
        entitled: true,
        platformEnabled: false,
        effective: false, // interrupteur plateforme éteint
      });
      expect(state.config).toMatchObject({ version: 1 });
      expect(state.config!.spaces.map((s) => s.label)).toEqual([
        'Table 1',
        'Comptoir',
      ]);
      expect(state.config!.windows).toHaveLength(2);
      expect(state.issues.map((i) => i.code)).toEqual(['PLATFORM_DISABLED']);
      expect(state.preview!.capacity.totalCovers).toBe(10);
    });

    it('interrupteur allumé : effectif (sans promettre de disponibilité client)', async () => {
      platformEnabled = true;
      await premium('rv-v1');
      const state = await save('rv-o1');
      expect(state.effective).toBe(true);
    });

    it.each([
      ['Standard (aucune période)', null],
      ['abonnement expiré', { endsAt: new Date(NOW.getTime() - 1) }],
      ['abonnement révoqué', { status: 'REVOKED' }],
      ['abonnement futur', { startsAt: new Date(NOW.getTime() + DAY) }],
    ])('%s → 403 PREMIUM_REQUIRED, rien d’écrit', async (_label, period) => {
      if (period) await premium('rv-v1', period);
      await expect(save('rv-o1')).rejects.toMatchObject({
        status: 403,
        response: { code: 'PREMIUM_REQUIRED' },
      });
      expect(await counts()).toEqual({ settings: 0, spaces: 0, windows: 0 });
    });

    it('expiration : la configuration reste lisible et gelée', async () => {
      await premium('rv-v1', { endsAt: new Date(NOW.getTime() + 1000) });
      await save('rv-o1');
      const later = new Date(NOW.getTime() + 2000);
      const state = await service.getMine('rv-o1', later);
      expect(state).toMatchObject({
        configured: true,
        enabled: true,
        entitled: false,
        effective: false,
      });
      await expect(
        service.save('rv-o1', body({ version: 1 }) as never, later),
      ).rejects.toMatchObject({ status: 403 });
    });

    it('Standard : GET lisible et prévisualisation sans écriture', async () => {
      const state = await service.getMine('rv-o1', NOW);
      expect(state).toMatchObject({
        eligible: true,
        configured: false,
        entitled: false,
        config: null,
      });
      expect(state.limits.slotDurationMin).toMatchObject({ default: 90 });

      const preview = await service.preview('rv-o1', body() as never, NOW);
      expect(preview).toMatchObject({ valid: true, entitled: false });
      expect(preview.issues.map((i) => i.code)).toContain('NOT_ENTITLED');
      expect(await counts()).toEqual({ settings: 0, spaces: 0, windows: 0 });
    });

    it('type non éligible (HOME_COOK) : GET eligible=false, preview et PUT → 403', async () => {
      await premium('rv-v3');
      expect(await service.getMine('rv-o3', NOW)).toMatchObject({
        eligible: false,
        effective: false,
      });
      const refused = {
        status: 403,
        response: { code: 'RESERVATIONS_NOT_AVAILABLE_FOR_VENDOR_TYPE' },
      };
      await expect(
        service.preview('rv-o3', body() as never, NOW),
      ).rejects.toMatchObject(refused);
      await expect(save('rv-o3')).rejects.toMatchObject(refused);
      expect(await counts()).toEqual({ settings: 0, spaces: 0, windows: 0 });
    });

    it('compte sans restaurant → 403', async () => {
      await expect(
        service.getMine('rv-sans-boutique', NOW),
      ).rejects.toMatchObject({
        status: 403,
      });
      await expect(save('rv-sans-boutique')).rejects.toMatchObject({
        status: 403,
      });
    });
  });

  describe('ownership des ressources', () => {
    it('id de ressource d’un autre restaurant → 400 UNKNOWN_RESOURCE_ID, rien ne bouge', async () => {
      await premium('rv-v1');
      await premium('rv-v2');
      const v1 = await save('rv-o1');
      const foreignId = v1.config!.spaces[0].id;

      const attempt = save('rv-o2', {
        spaces: [
          {
            id: foreignId,
            kind: 'TABLE',
            label: 'Volée',
            minGuests: 1,
            maxGuests: 4,
          },
        ],
      });
      await expect(attempt).rejects.toMatchObject({
        status: 400,
        response: {
          code: 'RESERVATION_SETTINGS_INVALID',
          issues: expect.arrayContaining([
            expect.objectContaining({ code: 'UNKNOWN_RESOURCE_ID' }),
          ]),
        },
      });
      const untouched = await prisma.reservationSpace.findUniqueOrThrow({
        where: { id: foreignId },
      });
      expect(untouched).toMatchObject({
        restaurantId: 'rv-v1',
        label: 'Table 1',
      });
      expect(
        await prisma.reservationSettings.count({
          where: { restaurantId: 'rv-v2' },
        }),
      ).toBe(0);
    });
  });

  describe('validation et archivage', () => {
    beforeEach(() => premium('rv-v1'));

    it('nom avec un caractère invisible → 400, constat sous ce champ, rien d’écrit', async () => {
      await expect(
        save('rv-o1', {
          spaces: [
            { kind: 'TABLE', label: 'Table 1', minGuests: 1, maxGuests: 4 },
            {
              kind: 'TABLE',
              label: `Table 1${String.fromCharCode(0x200b)}`,
              minGuests: 1,
              maxGuests: 4,
            },
          ],
        }),
      ).rejects.toMatchObject({
        status: 400,
        response: {
          code: 'RESERVATION_SETTINGS_INVALID',
          issues: expect.arrayContaining([
            expect.objectContaining({
              code: 'LABEL_INVALID_CHARS',
              field: 'spaces[1].label',
            }),
          ]),
        },
      });
      expect(await counts()).toEqual({ settings: 0, spaces: 0, windows: 0 });
    });

    it('libellés en double → 400, aucune écriture partielle', async () => {
      await expect(
        save('rv-o1', {
          spaces: [
            { kind: 'TABLE', label: 'Table 1', minGuests: 1, maxGuests: 4 },
            { kind: 'TABLE', label: ' TABLE  1', minGuests: 1, maxGuests: 2 },
          ],
        }),
      ).rejects.toMatchObject({ status: 400 });
      expect(await counts()).toEqual({ settings: 0, spaces: 0, windows: 0 });
    });

    it('ressource active omise → 400 MISSING_RESOURCE, version inchangée', async () => {
      await save('rv-o1');
      await expect(
        save('rv-o1', {
          version: 1,
          spaces: [
            { kind: 'TABLE', label: 'Autre', minGuests: 1, maxGuests: 4 },
          ],
        }),
      ).rejects.toMatchObject({
        status: 400,
        response: {
          issues: expect.arrayContaining([
            expect.objectContaining({ code: 'MISSING_RESOURCE' }),
          ]),
        },
      });
      const settings = await prisma.reservationSettings.findUniqueOrThrow({
        where: { restaurantId: 'rv-v1' },
      });
      expect(settings.version).toBe(1);
      expect(
        await prisma.reservationSpace.count({ where: { archivedAt: null } }),
      ).toBe(2);
    });

    it('archivage explicite : la ligne reste, le libellé est réutilisable', async () => {
      const first = await save('rv-o1');
      const [table, seats] = first.config!.spaces;
      const second = await save('rv-o1', {
        version: 1,
        spaces: [
          { id: table.id, kind: 'TABLE', label: 'Table 1', archived: true },
          {
            id: seats.id,
            kind: 'SEATS',
            label: 'Comptoir',
            seatCount: 6,
            maxSeatsPerBooking: 2,
          },
          { kind: 'TABLE', label: 'table 1', minGuests: 2, maxGuests: 6 },
        ],
        maxPartySize: 6,
      });
      expect(second.config!.version).toBe(2);
      expect(second.config!.archivedSpaces.map((s) => s.id)).toEqual([
        table.id,
      ]);
      expect(second.config!.spaces.map((s) => s.label)).toEqual([
        'Comptoir',
        'table 1',
      ]);
      const archived = await prisma.reservationSpace.findUniqueOrThrow({
        where: { id: table.id },
      });
      expect(archived.archivedAt).not.toBeNull();
    });

    it('table convertie en espace de places sous le même id → 400 RESOURCE_KIND_CHANGED, rien ne bouge', async () => {
      const first = await save('rv-o1');
      const [table, seats] = first.config!.spaces;
      const before = await prisma.reservationSpace.findMany({
        orderBy: { id: 'asc' },
      });
      const converted = {
        version: 1,
        spaces: [
          {
            id: table.id,
            kind: 'SEATS',
            label: 'Table 1',
            seatCount: 4,
            maxSeatsPerBooking: 4,
          },
          {
            id: seats.id,
            kind: 'SEATS',
            label: 'Comptoir',
            seatCount: 6,
            maxSeatsPerBooking: 2,
          },
        ],
      };
      await expect(save('rv-o1', converted)).rejects.toMatchObject({
        status: 400,
        response: {
          code: 'RESERVATION_SETTINGS_INVALID',
          issues: expect.arrayContaining([
            expect.objectContaining({
              code: 'RESOURCE_KIND_CHANGED',
              field: 'spaces[0].kind',
            }),
          ]),
        },
      });
      // L'aperçu applique le même moteur : même verdict, sans écriture.
      const { version: _v, ...draftOnly } = body(converted);
      const preview = await service.preview('rv-o1', draftOnly as never, NOW);
      expect(preview.valid).toBe(false);
      expect(preview.issues.map((i) => i.code)).toContain(
        'RESOURCE_KIND_CHANGED',
      );
      expect(
        await prisma.reservationSpace.findMany({ orderBy: { id: 'asc' } }),
      ).toEqual(before);
      const settings = await prisma.reservationSettings.findUniqueOrThrow({
        where: { restaurantId: 'rv-v1' },
      });
      expect(settings.version).toBe(1);
    });

    it('id d’un autre restaurant sous un autre type → UNKNOWN_RESOURCE_ID, le type ne fuit pas', async () => {
      await premium('rv-v2');
      const foreign = await save('rv-o2');
      const foreignTableId = foreign.config!.spaces[0].id;
      const error = await save('rv-o1', {
        spaces: [
          {
            id: foreignTableId,
            kind: 'SEATS',
            label: 'Volée',
            seatCount: 4,
            maxSeatsPerBooking: 2,
          },
        ],
      }).catch(
        (e: { status: number; response: { issues: { code: string }[] } }) => e,
      );
      expect(error).toMatchObject({ status: 400 });
      const issueCodes = (
        error as { response: { issues: { code: string }[] } }
      ).response.issues.map((i) => i.code);
      expect(issueCodes).toContain('UNKNOWN_RESOURCE_ID');
      expect(issueCodes).not.toContain('RESOURCE_KIND_CHANGED');
      expect(
        await prisma.reservationSpace.findUniqueOrThrow({
          where: { id: foreignTableId },
        }),
      ).toMatchObject({ restaurantId: 'rv-v2', kind: 'TABLE' });
    });

    it('mise à jour groupée : chaque colonne réécrite, ordre et date compris', async () => {
      const first = await save('rv-o1');
      const [table, seats] = first.config!.spaces;
      const before = await prisma.reservationSpace.findUniqueOrThrow({
        where: { id: table.id },
      });
      await new Promise((r) => setTimeout(r, 10));
      const second = await save('rv-o1', {
        version: 1,
        maxPartySize: 6,
        spaces: [
          {
            id: seats.id,
            kind: 'SEATS',
            label: 'Bar',
            seatCount: 9,
            maxSeatsPerBooking: 3,
          },
          {
            id: table.id,
            kind: 'TABLE',
            label: 'Fenêtre',
            minGuests: 2,
            maxGuests: 6,
          },
        ],
      });
      expect(second.config!.version).toBe(2);
      const rows = await prisma.reservationSpace.findMany({
        orderBy: { position: 'asc' },
      });
      expect(
        rows.map((r) => [
          r.id,
          r.kind,
          r.label,
          r.labelKey,
          r.minGuests,
          r.maxGuests,
          r.seatCount,
          r.maxSeatsPerBooking,
          r.position,
        ]),
      ).toEqual([
        [seats.id, 'SEATS', 'Bar', 'bar', null, null, 9, 3, 0],
        [table.id, 'TABLE', 'Fenêtre', 'fenêtre', 2, 6, null, null, 1],
      ]);
      const after = rows.find((r) => r.id === table.id)!;
      expect(after.updatedAt.getTime()).toBeGreaterThan(
        before.updatedAt.getTime(),
      );
      // Date liée en SQL brut sur une colonne sans fuseau : elle doit rester
      // en UTC (un décalage d'une heure passerait le test ci-dessus).
      expect(Math.abs(after.updatedAt.getTime() - Date.now())).toBeLessThan(
        60_000,
      );
    });

    it('échange des noms de deux tables existantes : accepté (index partiel)', async () => {
      const first = await save('rv-o1', {
        spaces: [
          { kind: 'TABLE', label: 'A', minGuests: 1, maxGuests: 4 },
          { kind: 'TABLE', label: 'B', minGuests: 1, maxGuests: 4 },
        ],
      });
      const [a, b] = first.config!.spaces;
      const second = await save('rv-o1', {
        version: 1,
        spaces: [
          { id: a.id, kind: 'TABLE', label: 'B', minGuests: 1, maxGuests: 4 },
          { id: b.id, kind: 'TABLE', label: 'A', minGuests: 1, maxGuests: 4 },
        ],
      });
      const byId = new Map(second.config!.spaces.map((s) => [s.id, s.label]));
      expect(byId.get(a.id)).toBe('B');
      expect(byId.get(b.id)).toBe('A');
    });

    it('brouillon désactivé et incomplet : accepté', async () => {
      const state = await save('rv-o1', {
        enabled: false,
        spaces: [],
        windows: [],
      });
      expect(state).toMatchObject({
        configured: true,
        enabled: false,
        effective: false,
      });
    });

    it('plage du samedi dans le débordement d’un horaire de nuit : jugée dans les horaires', async () => {
      await prisma.operatingHours.update({
        where: {
          restaurantId_dayOfWeek: {
            restaurantId: 'rv-v1',
            dayOfWeek: 'VENDREDI',
          },
        },
        data: { openTime: '20:00', closeTime: '02:00' },
      });
      await prisma.operatingHours.update({
        where: {
          restaurantId_dayOfWeek: {
            restaurantId: 'rv-v1',
            dayOfWeek: 'SAMEDI',
          },
        },
        data: { isClosed: true },
      });
      const state = await save('rv-o1', {
        slotDurationMin: 60,
        windows: [
          { dayOfWeek: 'SAMEDI', startTime: '00:00', endTime: '00:30' },
        ],
      });
      expect(state.issues.map((i) => i.code)).toEqual(['PLATFORM_DISABLED']);
    });

    it('version périmée → 409 RESERVATION_SETTINGS_CONFLICT', async () => {
      await save('rv-o1');
      await expect(save('rv-o1', { version: 0 })).rejects.toMatchObject({
        status: 409,
        response: { code: 'RESERVATION_SETTINGS_CONFLICT' },
      });
    });
  });

  describe('concurrence', () => {
    beforeEach(() => premium('rv-v1'));

    it('deux enregistrements simultanés sur la même version : un succès, un 409', async () => {
      const first = await save('rv-o1');
      // Le même formulaire, relu puis modifié sur deux appareils.
      const spaces = first.config!.spaces.map((sp) => ({
        id: sp.id,
        kind: sp.kind,
        label: sp.label,
        minGuests: sp.minGuests ?? undefined,
        maxGuests: sp.maxGuests ?? undefined,
        seatCount: sp.seatCount ?? undefined,
        maxSeatsPerBooking: sp.maxSeatsPerBooking ?? undefined,
      }));
      const results = await Promise.allSettled([
        save('rv-o1', { version: 1, spaces, maxPartySize: 2 }),
        save('rv-o1', { version: 1, spaces, maxPartySize: 3 }),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.find(
        (r) => r.status === 'rejected',
      ) as PromiseRejectedResult;
      expect(rejected.reason).toMatchObject({
        status: 409,
        response: { code: 'RESERVATION_SETTINGS_CONFLICT' },
      });
      const settings = await prisma.reservationSettings.findUniqueOrThrow({
        where: { restaurantId: 'rv-v1' },
      });
      expect(settings.version).toBe(2);
    });

    it('deux premières créations simultanées : une seule configuration', async () => {
      const results = await Promise.allSettled([save('rv-o1'), save('rv-o1')]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(await counts()).toEqual({ settings: 1, spaces: 2, windows: 2 });
    });

    it('révocation qui tient le verrou Restaurant : l’enregistrement qui l’attend est refusé', async () => {
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      let locked!: () => void;
      const lockTaken = new Promise<void>((r) => (locked = r));

      const revocation = prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT "id" FROM "Restaurant" WHERE "id" = 'rv-v1' FOR UPDATE`;
          await tx.vendorSubscription.updateMany({
            where: { restaurantId: 'rv-v1' },
            data: {
              status: 'REVOKED',
              revokedAt: NOW,
              revokedById: 'admin-test',
              revokeReason: 'test',
            },
          });
          locked();
          await gate;
        },
        { timeout: 10_000 },
      );
      await lockTaken;
      const saving = save('rv-o1');
      await new Promise((r) => setTimeout(r, 300)); // l'enregistrement attend le verrou
      release();
      await revocation;

      await expect(saving).rejects.toMatchObject({
        status: 403,
        response: { code: 'PREMIUM_REQUIRED' },
      });
      expect(await counts()).toEqual({ settings: 0, spaces: 0, windows: 0 });
    });

    // ── Verrou `Restaurant` et checkout (revue du 12/10) ──────────────────
    // Insérer une commande prend, au titre de la clé étrangère, un
    // `FOR KEY SHARE` sur la ligne `Restaurant`. `FOR UPDATE` lui est
    // incompatible ; `FOR NO KEY UPDATE` ne l'est pas, tout en restant
    // incompatible avec le `FOR UPDATE` de l'attribution / révocation.
    const ROLLBACK = new Error('rollback volontaire');
    const orderData = {
      restaurantId: 'rv-v1',
      userId: 'rv-o2',
      subTotal: 1000,
      deliveryFee: 0,
      total: 1000,
      paymentMethod: 'MTN_MOMO' as const,
    };
    /** Une transaction ouverte jusqu'à `release()`, puis annulée. */
    const holdOpen = (
      work: (tx: Prisma.TransactionClient) => Promise<unknown>,
    ) => {
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      let ready!: () => void;
      const started = new Promise<void>((r) => (ready = r));
      const done = prisma
        .$transaction(
          async (tx) => {
            await work(tx);
            ready();
            await gate;
            throw ROLLBACK;
          },
          { timeout: 15_000 },
        )
        .catch((e: unknown) => {
          if (e !== ROLLBACK) throw e;
        });
      return { started, release, done };
    };
    const admin = () =>
      prisma.user.create({
        data: {
          id: 'rv-admin',
          firebaseUid: 'fb-rv-admin',
          email: 'rv-admin@t.local',
          role: 'ADMIN',
        },
      });
    const within = <T>(p: Promise<T>, ms: number) =>
      Promise.race([
        p.then(() => 'terminé' as const),
        new Promise<'bloqué'>((r) => setTimeout(() => r('bloqué'), ms)),
      ]);

    it('checkout en cours (commande insérée, non validée) : l’enregistrement n’attend pas', async () => {
      const checkout = holdOpen((tx) => tx.order.create({ data: orderData }));
      await checkout.started;
      const saving = save('rv-o1');
      const outcome = await within(saving, 3_000);
      checkout.release();
      await checkout.done;
      await saving.catch(() => undefined);
      expect(outcome).toBe('terminé');
      expect(await counts()).toEqual({ settings: 1, spaces: 2, windows: 2 });
    });

    it.each([
      ['FOR UPDATE', 'bloquée'],
      ['FOR NO KEY UPDATE', 'acceptée'],
    ])(
      'comparaison : verrou %s tenu → insertion d’une commande %s',
      async (mode, expected) => {
        const holder = holdOpen((tx) =>
          tx.$queryRawUnsafe(
            `SELECT "id" FROM "Restaurant" WHERE "id" = 'rv-v1' ${mode}`,
          ),
        );
        await holder.started;
        const inserting = prisma.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '1500ms'`);
          await tx.order.create({ data: orderData });
          throw ROLLBACK;
        });
        const result = await inserting.then(
          () => 'acceptée',
          (e: unknown) => (e === ROLLBACK ? 'acceptée' : 'bloquée'),
        );
        holder.release();
        await holder.done;
        expect(result).toBe(expected);
      },
    );

    it('FOR NO KEY UPDATE tenu : la vraie révocation attend toujours (sérialisation conservée)', async () => {
      const sub = await prisma.vendorSubscription.findFirstOrThrow({
        where: { restaurantId: 'rv-v1' },
      });
      const holder = holdOpen(
        (tx) =>
          tx.$queryRaw`SELECT "id" FROM "Restaurant" WHERE "id" = 'rv-v1' FOR NO KEY UPDATE`,
      );
      await holder.started;
      const subscriptions = new VendorSubscriptionService(
        prisma as never,
        {
          getSettings: async () => ({ premiumMonthlyPriceXaf: 15000 }),
        } as never,
      );
      // La révocation écrit un journal d'audit : l'acteur doit exister.
      await admin();
      const revoking = subscriptions.revoke(
        'rv-v1',
        sub.id,
        'rv-admin',
        'test de sérialisation',
        NOW,
      );
      expect(await within(revoking, 1_500)).toBe('bloqué');
      holder.release();
      await holder.done;
      await expect(revoking).resolves.toMatchObject({ status: 'REVOKED' });
    });

    it('rafale mixte (enregistrements, commandes, attribution) : aucun interblocage', async () => {
      const first = await save('rv-o1');
      await admin();
      const spaces = first.config!.spaces.map((sp) => ({
        id: sp.id,
        kind: sp.kind,
        label: sp.label,
        minGuests: sp.minGuests ?? undefined,
        maxGuests: sp.maxGuests ?? undefined,
        seatCount: sp.seatCount ?? undefined,
        maxSeatsPerBooking: sp.maxSeatsPerBooking ?? undefined,
      }));
      const subscriptions = new VendorSubscriptionService(
        prisma as never,
        {
          getSettings: async () => ({ premiumMonthlyPriceXaf: 15000 }),
        } as never,
      );
      const results = await Promise.allSettled([
        ...Array.from({ length: 4 }, (_, i) =>
          save('rv-o1', { version: 1, spaces, maxPartySize: 2 + (i % 2) }),
        ),
        ...Array.from({ length: 4 }, () =>
          prisma.order.create({ data: orderData }),
        ),
        subscriptions.grant(
          {
            restaurantId: 'rv-v1',
            adminId: 'rv-admin',
            paymentMethod: 'CASH',
            requestKey: `burst-${Date.now()}`,
          },
          NOW,
        ),
      ]);
      const failures = results.filter(
        (r): r is PromiseRejectedResult => r.status === 'rejected',
      );
      // Seuls refus admis : les 409 de version des enregistrements concurrents.
      for (const f of failures) {
        expect(f.reason).toMatchObject({ status: 409 });
      }
      expect(JSON.stringify(failures.map((f) => String(f.reason)))).not.toMatch(
        /deadlock|40P01/i,
      );
      expect(
        results.slice(0, 4).filter((r) => r.status === 'fulfilled'),
      ).toHaveLength(1);
      expect(
        await prisma.order.count({ where: { restaurantId: 'rv-v1' } }),
      ).toBe(4);
      await prisma.order.deleteMany({ where: { restaurantId: 'rv-v1' } });
    });
  });

  describe('contraintes en base (migration)', () => {
    it.each([
      ['slotStepMin', 20],
      ['slotDurationMin', 241],
      ['bufferMin', 61],
      ['minLeadMin', 29],
      ['maxAdvanceDays', 0],
      ['maxPartySize', 51],
    ])(
      'réglage hors bornes refusé en base : %s = %s',
      async (column, value) => {
        await expect(
          prisma.$executeRawUnsafe(
            `INSERT INTO "ReservationSettings" ("restaurantId", "updatedById", "updatedAt", "${column}")
           VALUES ('rv-v1', 'u', now(), ${value})`,
          ),
        ).rejects.toThrow(/check/i);
      },
    );

    const insertSpace = (cols: string, values: string) =>
      prisma.$executeRawUnsafe(
        `INSERT INTO "ReservationSpace" ("id", "restaurantId", "updatedAt", ${cols})
         VALUES (gen_random_uuid()::text, 'rv-v1', now(), ${values})`,
      );

    it('forme d’une ressource contrôlée par type', async () => {
      await expect(
        insertSpace(
          '"kind","label","labelKey","minGuests","maxGuests","seatCount"',
          "'TABLE','T','t',1,4,3",
        ),
      ).rejects.toThrow(/check/i);
      await expect(
        insertSpace(
          '"kind","label","labelKey","seatCount","maxSeatsPerBooking"',
          "'SEATS','S','s',4,6",
        ),
      ).rejects.toThrow(/check/i);
      await expect(
        insertSpace(
          '"kind","label","labelKey","minGuests","maxGuests"',
          "'BOOTH','B','b',1,2",
        ),
      ).rejects.toThrow(/check/i);
    });

    it('index unique partiel : doublon actif refusé, doublon archivé accepté', async () => {
      const cols = '"kind","label","labelKey","minGuests","maxGuests"';
      await insertSpace(cols, "'TABLE','T1','t1',1,4");
      await expect(insertSpace(cols, "'TABLE','T1','t1',1,4")).rejects.toThrow(
        /unique|duplicate/i,
      );
      await insertSpace(`${cols},"archivedAt"`, "'TABLE','T1','t1',1,4, now()");
      expect(await prisma.reservationSpace.count()).toBe(2);
    });

    it('plage : format et ordre contrôlés (pas de plage de nuit)', async () => {
      const insertWindow = (start: string, end: string) =>
        prisma.$executeRawUnsafe(
          `INSERT INTO "ReservationWindow" ("id","restaurantId","dayOfWeek","startTime","endTime")
           VALUES (gen_random_uuid()::text, 'rv-v1', 'LUNDI', '${start}', '${end}')`,
        );
      await expect(insertWindow('22:00', '01:00')).rejects.toThrow(/check/i);
      await expect(insertWindow('9:00', '10:00')).rejects.toThrow(/check/i);
      await insertWindow('12:00', '14:00');
    });
  });
});
