import { Pool, PoolClient } from 'pg';

/**
 * **F3-12.1-A — invariants de `DeliveryOffer` portés par la base.**
 *
 * Migration `20260929100000_dispatch_offers`. Ces garanties ne dépendent
 * d'aucun service : un script, une correction SQL ou un bogue du futur
 * `advance()` doivent se heurter à la base elle-même. Les écritures passent
 * donc en SQL brut, par `pg` directement — l'oracle est le code SQLSTATE et le
 * nom de la contrainte, pas un message.
 *
 * Mutations que cette suite doit tuer (Discovery 12.1, §16) : M-U1 à M-U3
 * (index uniques partiels), M-T1 à M-T3 (triggers).
 *
 * Se saute proprement sans `TEST_DATABASE_URL`.
 */
const DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

const UNIQUE = '23505';
const CHECK = '23514';
// `ON DELETE RESTRICT` lève `restrict_violation`, pas `foreign_key_violation` (23503).
const RESTRICT = '23001';

describeIfDb(
  'F3-12.1-A — schéma des offres de course (PostgreSQL réel)',
  () => {
    let pool: Pool;

    const CLIENT = 'dos-client';
    const OWNER = 'dos-owner';
    const A = 'dos-driver-a';
    const B = 'dos-driver-b';
    const VENDOR = 'dos-vendor';
    /** Deux courses, pour distinguer « par course » de « par livreur ». */
    const D1 = 'dos-d1';
    const D2 = 'dos-d2';

    const q = (sql: string, params: unknown[] = []) => pool.query(sql, params);

    /** Refus attendu : SQLSTATE + nom de contrainte, rien de moins. */
    const expectRefused = async (
      run: Promise<unknown>,
      code: string,
      constraint: string,
    ) => {
      await expect(run).rejects.toMatchObject({ code, constraint });
    };

    const setDispatch = (enabled: boolean) =>
      q(
        `UPDATE "PlatformSettings" SET "dispatchEnabled" = $1 WHERE id = 'singleton'`,
        [enabled],
      );

    interface OfferInput {
      id: string;
      deliveryId?: string;
      driverId?: string;
      status?: string;
      round?: number;
      pickReason?: string | null;
      poolSize?: number;
      employmentType?: string;
      compensationModel?: string;
      baseXaf?: number;
      sharePercent?: number | null;
      payXaf?: number;
      /** Secondes après `now()`. Négatif = offre déjà échue. */
      expiresIn?: number;
      offeredAgo?: number;
      respondedAt?: 'now' | null;
      declineReason?: string | null;
    }

    /**
     * Offre valide par défaut : PER_DELIVERY, 35 % de 1 000 = 350 XAF, 90 s.
     * Chaque test ne dérègle qu'un champ.
     */
    const insertOffer = (o: OfferInput, client: Pool | PoolClient = pool) =>
      client.query(
        `INSERT INTO "DeliveryOffer"
         (id, "deliveryId", "driverId", status, round, "pickReason", "poolSize",
          "employmentType", "compensationModel", "baseXaf", "sharePercent",
          "payXaf", "offeredAt", "expiresAt", "respondedAt", "declineReason")
       VALUES ($1, $2, $3, $4::"DeliveryOfferStatus", $5,
               $6::"DispatchPickReason", $7,
               $8::"DriverEmploymentType", $9::"DriverCompensationModel",
               $10, $11, $12,
               now() - make_interval(secs => $13),
               now() + make_interval(secs => $14),
               CASE WHEN $15::text = 'now' THEN now() END,
               $16::"OfferDeclineReason")`,
        [
          o.id,
          o.deliveryId ?? D1,
          o.driverId ?? A,
          o.status ?? 'OFFERED',
          o.round ?? 1,
          o.pickReason === undefined ? 'LILIA_PRIORITY' : o.pickReason,
          o.poolSize ?? 2,
          o.employmentType ?? 'LILIA',
          o.compensationModel ?? 'PER_DELIVERY',
          o.baseXaf ?? 1000,
          o.sharePercent === undefined ? 35 : o.sharePercent,
          o.payXaf ?? 350,
          o.offeredAgo ?? 0,
          o.expiresIn ?? 90,
          o.respondedAt ?? null,
          o.declineReason ?? null,
        ],
      );

    const offer = async (id: string) =>
      (await q(`SELECT * FROM "DeliveryOffer" WHERE id = $1`, [id])).rows[0] as
        | Record<string, unknown>
        | undefined;

    beforeAll(async () => {
      pool = new Pool({ connectionString: DATABASE_URL });
      await q(`
      TRUNCATE TABLE "DeliveryOffer", "DeliveryAssignment", "Delivery",
                     "OrderItem", "OrderHistory", "Order", "DriverProfile",
                     "Restaurant", "PlatformSettings", "User"
      RESTART IDENTITY CASCADE
    `);
      await q(
        `INSERT INTO "PlatformSettings" (id, "updatedAt") VALUES ('singleton', now())`,
      );
      await q(
        `INSERT INTO "User" (id, "firebaseUid", email, role, "driverStatus", "updatedAt")
       VALUES ($1, 'fb-dos-c', 'dos-c@test.local', 'CLIENT', NULL, now()),
              ($2, 'fb-dos-o', 'dos-o@test.local', 'RESTAURATEUR', NULL, now()),
              ($3, 'fb-dos-a', 'dos-a@test.local', 'LIVREUR', 'AVAILABLE', now()),
              ($4, 'fb-dos-b', 'dos-b@test.local', 'LIVREUR', 'AVAILABLE', now())`,
        [CLIENT, OWNER, A, B],
      );
      await q(
        `INSERT INTO "DriverProfile" (id, "userId", "isActive", "updatedAt")
       VALUES ('dos-prof-a', $1, true, now()), ('dos-prof-b', $2, true, now())`,
        [A, B],
      );
      await q(
        `INSERT INTO "Restaurant" (id, nom, adresse, phone, "ownerId", "updatedAt")
       VALUES ($1, 'Chez Offre', 'Moungali', '060000012', $2, now())`,
        [VENDOR, OWNER],
      );
      for (const d of [D1, D2]) {
        await q(
          `INSERT INTO "Order" (id, "restaurantId", "userId", "subTotal", "deliveryFee",
                              "deliveryFeeGross", "serviceFee", total, "paymentMethod",
                              status, "isDelivery", "updatedAt")
         VALUES ($1, $2, $3, 5000, 1000, 1000, 750, 6750, 'MTN_MOMO', 'PRET', true, now())`,
          [`${d}-order`, VENDOR, CLIENT],
        );
        await q(
          `INSERT INTO "Delivery" (id, "orderId", status, "updatedAt")
         VALUES ($1, $2, 'EN_ATTENTE', now())`,
          [d, `${d}-order`],
        );
      }
    });

    beforeEach(async () => {
      await q(`DELETE FROM "DeliveryOffer"`);
      await q(`DELETE FROM "DeliveryAssignment"`);
      await setDispatch(true);
    });

    afterAll(async () => {
      // Les autres suites suppriment des `User` : une offre restante (FK
      // RESTRICT) les ferait échouer, et l'interrupteur allumé les tromperait.
      await q(`DELETE FROM "DeliveryOffer"`);
      await setDispatch(false);
      await pool.end();
    });

    // ─── 1. Défauts : la migration seule n'allume rien ──────────────────────

    describe('1 — défauts de rollout', () => {
      it('interrupteur éteint, vendeur MANUAL, livreur sans capacité', async () => {
        // Ligne neuve = ce que la migration pose sur la ligne de production.
        await q(
          `INSERT INTO "PlatformSettings" (id, "updatedAt") VALUES ('dos-probe', now())`,
        );
        const fresh = (
          await q(`SELECT * FROM "PlatformSettings" WHERE id = 'dos-probe'`)
        ).rows[0];
        await q(`DELETE FROM "PlatformSettings" WHERE id = 'dos-probe'`);
        expect(fresh).toMatchObject({
          dispatchEnabled: false,
          dispatchOfferSeconds: 90,
          dispatchMaxRounds: 2,
          dispatchMaxSearchMinutes: 8,
          dispatchLeadMinutes: 15,
          dispatchAutoOfflineAfterExpired: 2,
          dispatchIndependentEveryN: 4,
        });

        const vendor = (
          await q(`SELECT "dispatchMode" FROM "Restaurant" WHERE id = $1`, [
            VENDOR,
          ])
        ).rows[0];
        expect(vendor.dispatchMode).toBe('MANUAL');

        const profile = (
          await q(
            `SELECT "offersEnabledAt", "consecutiveExpiredOffers"
             FROM "DriverProfile" WHERE "userId" = $1`,
            [A],
          )
        ).rows[0];
        expect(profile).toEqual({
          offersEnabledAt: null,
          consecutiveExpiredOffers: 0,
        });

        const delivery = (
          await q(
            `SELECT "dispatchDueAt", "dispatchStartedAt", "dispatchEndedAt",
                  "dispatchOutcome", "dispatchEndReason"
             FROM "Delivery" WHERE id = $1`,
            [D1],
          )
        ).rows[0];
        expect(Object.values(delivery).every((v) => v === null)).toBe(true);
      });
    });

    // ─── 2. Quatrième verrou : pas d'offre interrupteur éteint (M-T3) ───────

    describe('2 — trigger DeliveryOffer_dispatch_enabled', () => {
      it('refuse toute insertion quand dispatchEnabled = false', async () => {
        await setDispatch(false);
        await expectRefused(
          insertOffer({ id: 'o-off' }),
          CHECK,
          'DeliveryOffer_dispatch_enabled',
        );
        expect(await offer('o-off')).toBeUndefined();
      });

      it('refuse aussi quand la ligne singleton est absente', async () => {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          await client.query(
            `DELETE FROM "PlatformSettings" WHERE id = 'singleton'`,
          );
          await expectRefused(
            insertOffer({ id: 'o-nosettings' }, client),
            CHECK,
            'DeliveryOffer_dispatch_enabled',
          );
        } finally {
          await client.query('ROLLBACK');
          client.release();
        }
      });

      it("n'agit que sur l'insertion : une offre ouverte s'accepte interrupteur éteint", async () => {
        await insertOffer({ id: 'o-open' });
        await setDispatch(false);
        await q(
          `UPDATE "DeliveryOffer" SET status = 'ACCEPTED', "respondedAt" = now()
          WHERE id = 'o-open' AND status = 'OFFERED' AND "expiresAt" > now()`,
        );
        expect((await offer('o-open'))?.status).toBe('ACCEPTED');
      });
    });

    // ─── 3. Index uniques partiels (M-U1, M-U2, M-U3) ────────────────────────

    describe('3 — une seule offre ouverte par course et par livreur', () => {
      it('I3 : deux offres OFFERED sur la même course sont refusées (M-U1)', async () => {
        await insertOffer({ id: 'o-1', driverId: A });
        await expectRefused(
          insertOffer({ id: 'o-2', driverId: B }),
          UNIQUE,
          'DeliveryOffer_open_per_delivery_uq',
        );
      });

      it('I2 : deux offres OFFERED au même livreur sont refusées (M-U2)', async () => {
        await insertOffer({ id: 'o-1', deliveryId: D1 });
        await expectRefused(
          insertOffer({ id: 'o-2', deliveryId: D2 }),
          UNIQUE,
          'DeliveryOffer_open_per_driver_uq',
        );
      });

      it('2ᵉ tour : la même course se ré-offre au même livreur une fois la 1ʳᵉ close', async () => {
        await insertOffer({ id: 'o-r1', round: 1 });
        await q(
          `UPDATE "DeliveryOffer" SET status = 'EXPIRED', "respondedAt" = now() WHERE id = 'o-r1'`,
        );
        await insertOffer({ id: 'o-r2', round: 2, pickReason: null });
        expect((await offer('o-r2'))?.status).toBe('OFFERED');
      });

      it("ON CONFLICT DO NOTHING : le conflit n'avorte pas la transaction (H1)", async () => {
        await insertOffer({ id: 'o-held', deliveryId: D2, driverId: A });
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const res = await client.query(
            `INSERT INTO "DeliveryOffer"
             (id, "deliveryId", "driverId", round, "poolSize", "employmentType",
              "compensationModel", "baseXaf", "sharePercent", "payXaf", "expiresAt")
           VALUES ('o-conflict', $1, $2, 1, 1, 'LILIA', 'PER_DELIVERY', 1000, 35, 350,
                   now() + interval '90 seconds')
           ON CONFLICT DO NOTHING RETURNING id`,
            [D1, A],
          );
          expect(res.rowCount).toBe(0);
          // La transaction est toujours utilisable : l'offre part au suivant.
          await insertOffer(
            { id: 'o-next', deliveryId: D1, driverId: B },
            client,
          );
          await client.query('COMMIT');
        } finally {
          client.release();
        }
        expect((await offer('o-next'))?.driverId).toBe(B);
        expect(await offer('o-conflict')).toBeUndefined();
      });

      it('I1 : une course a au plus une main ouverte au journal (M-U3)', async () => {
        const assign = (id: string, driver: string) =>
          q(
            `INSERT INTO "DeliveryAssignment"
             (id, "deliveryId", "orderId", "delivererId", "assignedByRole")
           VALUES ($1, $2, $3, $4, 'ADMIN')`,
            [id, D1, `${D1}-order`, driver],
          );
        await assign('as-1', A);
        await expectRefused(
          assign('as-2', B),
          UNIQUE,
          'DeliveryAssignment_open_per_delivery_uq',
        );
        // Une fois la main rendue, la suivante s'ouvre.
        await q(
          `UPDATE "DeliveryAssignment" SET "releasedAt" = now(), outcome = 'REASSIGNED'
          WHERE id = 'as-1'`,
        );
        await assign('as-2', B);
      });
    });

    // ─── 4. CHECK ────────────────────────────────────────────────────────────

    describe('4 — contraintes CHECK de DeliveryOffer', () => {
      it.each<[string, OfferInput, string]>([
        [
          'échéance avant l’offre',
          { id: 'c1', expiresIn: -10 },
          'DeliveryOffer_window_valid',
        ],
        ['tour 0', { id: 'c2', round: 0 }, 'DeliveryOffer_round_pool_valid'],
        [
          'vivier vide',
          { id: 'c3', poolSize: 0 },
          'DeliveryOffer_round_pool_valid',
        ],
        [
          'gain supérieur à l’assiette',
          { id: 'c4', payXaf: 1001 },
          'DeliveryOffer_pay_valid',
        ],
        ['gain négatif', { id: 'c5', payXaf: -1 }, 'DeliveryOffer_pay_valid'],
        [
          'taux > 100',
          { id: 'c6', sharePercent: 101 },
          'DeliveryOffer_pay_valid',
        ],
        [
          'par course sans taux',
          { id: 'c7', sharePercent: null },
          'DeliveryOffer_pay_valid',
        ],
        [
          'salaire avec taux',
          {
            id: 'c8',
            compensationModel: 'SALARY',
            sharePercent: 35,
            payXaf: 0,
          },
          'DeliveryOffer_pay_valid',
        ],
        [
          'salaire avec gain non nul',
          {
            id: 'c9',
            compensationModel: 'SALARY',
            sharePercent: null,
            payXaf: 350,
          },
          'DeliveryOffer_pay_valid',
        ],
        [
          'OFFERED déjà répondue',
          { id: 'c10', respondedAt: 'now' },
          'DeliveryOffer_response_valid',
        ],
        [
          'DECLINED sans issue datée',
          { id: 'c11', status: 'DECLINED' },
          'DeliveryOffer_response_valid',
        ],
        [
          'motif de refus sur une offre expirée',
          {
            id: 'c12',
            status: 'EXPIRED',
            respondedAt: 'now',
            declineReason: 'TOO_FAR',
          },
          'DeliveryOffer_response_valid',
        ],
        [
          'ACCEPTED après échéance (I9)',
          {
            id: 'c13',
            status: 'ACCEPTED',
            respondedAt: 'now',
            offeredAgo: 120,
            expiresIn: -30,
          },
          'DeliveryOffer_response_valid',
        ],
      ])('%s', async (_label, input, constraint) => {
        await expectRefused(insertOffer(input), CHECK, constraint);
      });

      it('un salarié à 0 XAF est une offre valide (un vrai zéro)', async () => {
        await insertOffer({
          id: 'c-salary',
          compensationModel: 'SALARY',
          sharePercent: null,
          payXaf: 0,
        });
        expect((await offer('c-salary'))?.payXaf).toBe(0);
      });

      it('vu avant d’être offert est refusé', async () => {
        await insertOffer({ id: 'c-seen' });
        await expectRefused(
          q(
            `UPDATE "DeliveryOffer" SET "seenAt" = "offeredAt" - interval '1 second'
            WHERE id = 'c-seen'`,
          ),
          CHECK,
          'DeliveryOffer_response_valid',
        );
      });

      it('I9 en base : accepter une offre échue est refusé même sans le CAS du service', async () => {
        await insertOffer({ id: 'c-late', offeredAgo: 120, expiresIn: -30 });
        await expectRefused(
          q(
            `UPDATE "DeliveryOffer" SET status = 'ACCEPTED', "respondedAt" = now()
            WHERE id = 'c-late'`,
          ),
          CHECK,
          'DeliveryOffer_response_valid',
        );
      });
    });

    describe('4 bis — contraintes CHECK hors DeliveryOffer', () => {
      it.each<[string, string, unknown[], string]>([
        [
          'recherche close sans issue',
          `UPDATE "Delivery" SET "dispatchDueAt" = now(), "dispatchEndedAt" = now() WHERE id = $1`,
          [D1],
          'Delivery_dispatch_consistent',
        ],
        [
          'motif de fin sur une recherche aboutie',
          `UPDATE "Delivery" SET "dispatchDueAt" = now(), "dispatchEndedAt" = now(),
                "dispatchOutcome" = 'ASSIGNED', "dispatchEndReason" = 'NO_CANDIDATE' WHERE id = $1`,
          [D1],
          'Delivery_dispatch_consistent',
        ],
        [
          'recherche démarrée sans échéance',
          `UPDATE "Delivery" SET "dispatchStartedAt" = now() WHERE id = $1`,
          [D1],
          'Delivery_dispatch_consistent',
        ],
        [
          'compteur d’expirations négatif',
          `UPDATE "DriverProfile" SET "consecutiveExpiredOffers" = -1 WHERE "userId" = $1`,
          [A],
          'DriverProfile_expired_offers_non_negative',
        ],
        [
          'offre de 10 s',
          `UPDATE "PlatformSettings" SET "dispatchOfferSeconds" = 10 WHERE id = $1`,
          ['singleton'],
          'PlatformSettings_dispatch_bounds',
        ],
        [
          '0 tour',
          `UPDATE "PlatformSettings" SET "dispatchMaxRounds" = 0 WHERE id = $1`,
          ['singleton'],
          'PlatformSettings_dispatch_bounds',
        ],
        [
          'quota négatif',
          `UPDATE "PlatformSettings" SET "dispatchIndependentEveryN" = -1 WHERE id = $1`,
          ['singleton'],
          'PlatformSettings_dispatch_bounds',
        ],
      ])('%s', async (_label, sql, params, constraint) => {
        await expectRefused(q(sql, params), CHECK, constraint);
      });

      it('une recherche épuisée, datée et motivée est valide', async () => {
        await q(
          `UPDATE "Delivery" SET "dispatchDueAt" = now(), "dispatchStartedAt" = now(),
                "dispatchEndedAt" = now(), "dispatchOutcome" = 'EXHAUSTED',
                "dispatchEndReason" = 'ROUNDS_EXHAUSTED' WHERE id = $1`,
          [D2],
        );
        await q(
          `UPDATE "Delivery" SET "dispatchDueAt" = NULL, "dispatchStartedAt" = NULL,
                "dispatchEndedAt" = NULL, "dispatchOutcome" = NULL,
                "dispatchEndReason" = NULL WHERE id = $1`,
          [D2],
        );
      });
    });

    // ─── 5. Trigger d'immuabilité (M-T1, M-T2) ──────────────────────────────

    describe('5 — trigger DeliveryOffer_immutable', () => {
      beforeEach(() => insertOffer({ id: 'im' }));

      it.each<[string, string]>([
        ['gain annoncé (M-T1)', `"payXaf" = 300`],
        ['assiette', `"baseXaf" = 900`],
        ['taux', `"sharePercent" = 40`],
        ['nature de la relation', `"employmentType" = 'INDEPENDENT'`],
        ['destinataire', `"driverId" = '${B}'`],
        ['course', `"deliveryId" = '${D2}'`],
        ['échéance repoussée', `"expiresAt" = "expiresAt" + interval '1 hour'`],
        ['offre antidatée', `"offeredAt" = "offeredAt" - interval '1 second'`],
        ['tour', `round = 2`],
        ['vivier', `"poolSize" = 5`],
        ['motif de choix effacé', `"pickReason" = NULL`],
      ])('%s', async (_label, set) => {
        await expectRefused(
          q(`UPDATE "DeliveryOffer" SET ${set} WHERE id = 'im'`),
          CHECK,
          'DeliveryOffer_terms_immutable',
        );
      });

      it('NULL → valeur est aussi refusé (IS DISTINCT FROM, pas <>)', async () => {
        await insertOffer({
          id: 'im-null',
          deliveryId: D2,
          driverId: B,
          pickReason: null,
        });
        await expectRefused(
          q(
            `UPDATE "DeliveryOffer" SET "pickReason" = 'ONLY_LILIA' WHERE id = 'im-null'`,
          ),
          CHECK,
          'DeliveryOffer_terms_immutable',
        );
      });

      it.each(['ACCEPTED', 'DECLINED', 'EXPIRED', 'CANCELLED'])(
        'un statut terminal %s est figé (M-T2 : EXPIRED → ACCEPTED)',
        async (terminal) => {
          await q(
            `UPDATE "DeliveryOffer" SET status = $1::"DeliveryOfferStatus", "respondedAt" = now()
            WHERE id = 'im'`,
            [terminal],
          );
          for (const next of ['OFFERED', 'ACCEPTED', 'EXPIRED']) {
            if (next === terminal) continue;
            await expectRefused(
              q(
                `UPDATE "DeliveryOffer" SET status = $1::"DeliveryOfferStatus" WHERE id = 'im'`,
                [next],
              ),
              CHECK,
              // Le trigger BEFORE parle avant les CHECK de la ligne.
              'DeliveryOffer_status_terminal',
            );
          }
        },
      );

      it('seenAt et respondedAt ne se réécrivent pas', async () => {
        await q(`UPDATE "DeliveryOffer" SET "seenAt" = now() WHERE id = 'im'`);
        await expectRefused(
          q(
            `UPDATE "DeliveryOffer" SET "seenAt" = now() + interval '1 second' WHERE id = 'im'`,
          ),
          CHECK,
          'DeliveryOffer_stamp_once',
        );
        await q(
          `UPDATE "DeliveryOffer" SET status = 'DECLINED', "respondedAt" = now(),
                "declineReason" = 'TOO_FAR' WHERE id = 'im'`,
        );
        await expectRefused(
          q(
            `UPDATE "DeliveryOffer" SET "respondedAt" = now() + interval '1 second' WHERE id = 'im'`,
          ),
          CHECK,
          'DeliveryOffer_stamp_once',
        );
        await expectRefused(
          q(
            `UPDATE "DeliveryOffer" SET "declineReason" = 'OTHER' WHERE id = 'im'`,
          ),
          CHECK,
          'DeliveryOffer_stamp_once',
        );
      });

      it('les transitions légitimes passent : vue, puis acceptation à l’heure DB', async () => {
        await q(
          `UPDATE "DeliveryOffer" SET "seenAt" = now()
          WHERE id = 'im' AND "seenAt" IS NULL AND status = 'OFFERED' AND "expiresAt" > now()`,
        );
        const res = await q(
          `UPDATE "DeliveryOffer" SET status = 'ACCEPTED', "respondedAt" = now()
          WHERE id = 'im' AND status = 'OFFERED' AND "driverId" = $1 AND "expiresAt" > now()`,
          [A],
        );
        expect(res.rowCount).toBe(1);
        const row = await offer('im');
        expect(row).toMatchObject({ status: 'ACCEPTED', payXaf: 350 });
        expect(row?.seenAt).not.toBeNull();
      });
    });

    // ─── 6. Clés étrangères ──────────────────────────────────────────────────

    describe('6 — clés étrangères', () => {
      it('supprimer un livreur qui a reçu une offre est refusé (RESTRICT)', async () => {
        await insertOffer({ id: 'fk-1' });
        await expectRefused(
          q(`DELETE FROM "User" WHERE id = $1`, [A]),
          RESTRICT,
          'DeliveryOffer_driverId_fkey',
        );
      });

      it('supprimer la course emporte ses offres (CASCADE, scripts d’exploitation)', async () => {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          await insertOffer({ id: 'fk-2', deliveryId: D2 }, client);
          await client.query(`DELETE FROM "Delivery" WHERE id = $1`, [D2]);
          const left = await client.query(
            `SELECT count(*)::int n FROM "DeliveryOffer" WHERE id = 'fk-2'`,
          );
          expect(left.rows[0].n).toBe(0);
        } finally {
          await client.query('ROLLBACK');
          client.release();
        }
      });
    });
  },
);
