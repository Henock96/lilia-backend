import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

import { VendorSubscriptionService } from '../../apps/lilia-app/src/modules/subscriptions/vendor-subscription.service';
import { addOneCalendarMonth } from '../../apps/lilia-app/src/modules/subscriptions/billing-period';

/**
 * Premium (Lot 2) — les garanties de l'abonnement sont des garanties de
 * BASE : un mock ne peut pas montrer deux administrateurs qui cliquent en
 * même temps. Ici, PostgreSQL réel :
 *  · attributions concurrentes → périodes contiguës, jamais chevauchantes
 *    (verrou `FOR UPDATE` sur le vendeur) ;
 *  · même clé rejouée en parallèle → une seule ligne (index unique) ;
 *  · double révocation → un seul succès (`updateMany … WHERE ACTIVE`) ;
 *  · CHECK de la migration : vocabulaires et cohérence refusés en base.
 */
const DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

describeIfDb('Abonnements vendeur (PostgreSQL réel)', () => {
  let prisma: PrismaClient;
  let service: VendorSubscriptionService;
  let price = 15000;

  beforeAll(async () => {
    prisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: DATABASE_URL }),
    });
    await prisma.$connect();
    service = new VendorSubscriptionService(
      prisma as never,
      { getSettings: async () => ({ premiumMonthlyPriceXaf: price }) } as never,
    );
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    price = 15000;
    await prisma.$executeRawUnsafe(`
      TRUNCATE TABLE "VendorSubscription", "User", "Restaurant"
      RESTART IDENTITY CASCADE
    `);
    for (const n of [1, 2]) {
      await prisma.user.create({
        data: {
          id: `vs-o${n}`,
          firebaseUid: `fb-vs-o${n}`,
          email: `vs-o${n}@t.local`,
          role: 'RESTAURATEUR',
        },
      });
      await prisma.restaurant.create({
        data: {
          id: `vs-v${n}`,
          nom: `Vendeur ${n}`,
          adresse: 'Moungali',
          phone: `06000009${n}`,
          ownerId: `vs-o${n}`,
        },
      });
    }
  });

  const grant = (key: string, restaurantId = 'vs-v1', now?: Date) =>
    service.grant(
      {
        restaurantId,
        adminId: 'admin-1',
        requestKey: key,
        paymentMethod: 'MOBILE_MONEY',
        paymentReference: 'MP-1',
      },
      now,
    );

  it('un mois, puis une prolongation empilée à la suite, prix figé', async () => {
    const now = new Date('2026-10-11T09:00:00Z');
    const first = (await grant('k1', 'vs-v1', now)).subscription;
    expect(first.startsAt).toEqual(now);
    expect(first.endsAt).toEqual(addOneCalendarMonth(now));
    expect(first.priceXaf).toBe(15000);

    price = 20000; // le réglage change après la première attribution
    const second = (await grant('k2', 'vs-v1', now)).subscription;
    expect(second.startsAt).toEqual(first.endsAt);
    expect(second.priceXaf).toBe(20000);

    const stored = await prisma.vendorSubscription.findUniqueOrThrow({
      where: { id: first.id },
    });
    expect(stored.priceXaf).toBe(15000); // jamais réécrit
  });

  it('cinq administrateurs en même temps : cinq mois contigus, aucun chevauchement', async () => {
    const results = await Promise.all(
      [1, 2, 3, 4, 5].map((i) => grant(`concurrent-${i}`)),
    );
    expect(results.every((r) => !r.replayed)).toBe(true);

    const periods = await prisma.vendorSubscription.findMany({
      where: { restaurantId: 'vs-v1' },
      orderBy: { startsAt: 'asc' },
    });
    expect(periods).toHaveLength(5);
    for (let i = 1; i < periods.length; i++) {
      expect(periods[i].startsAt).toEqual(periods[i - 1].endsAt);
    }
  });

  it('la même clé envoyée cinq fois en parallèle : une seule période', async () => {
    const results = await Promise.all(
      [1, 2, 3, 4, 5].map(() => grant('double-clic')),
    );
    const ids = new Set(results.map((r) => r.subscription.id));
    expect(ids.size).toBe(1);
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect(await prisma.vendorSubscription.count()).toBe(1);
  });

  it('une clé déjà servie pour un autre vendeur : 409, rien de créé', async () => {
    await grant('partagee', 'vs-v1');
    await expect(grant('partagee', 'vs-v2')).rejects.toMatchObject({
      status: 409,
    });
    expect(
      await prisma.vendorSubscription.count({
        where: { restaurantId: 'vs-v2' },
      }),
    ).toBe(0);
  });

  it('vendeur inconnu : 404', async () => {
    await expect(grant('k-x', 'inexistant')).rejects.toMatchObject({
      status: 404,
    });
  });

  it('révocation : le droit tombe ; une seconde révocation est refusée', async () => {
    const { subscription } = await grant('k-r');
    expect((await service.verdictFor('vs-v1')).active).toBe(true);

    const [a, b] = await Promise.allSettled([
      service.revoke('vs-v1', subscription.id, 'admin-1', 'Paiement contesté'),
      service.revoke('vs-v1', subscription.id, 'admin-2', 'Paiement contesté'),
    ]);
    const outcomes = [a.status, b.status].sort();
    expect(outcomes).toEqual(['fulfilled', 'rejected']);

    expect((await service.verdictFor('vs-v1')).active).toBe(false);
    const stored = await prisma.vendorSubscription.findUniqueOrThrow({
      where: { id: subscription.id },
    });
    expect(stored.status).toBe('REVOKED');
    expect(stored.revokeReason).toBe('Paiement contesté');
  });

  it('révoquer la période d’un AUTRE vendeur : 404 (pas de fuite entre vendeurs)', async () => {
    const { subscription } = await grant('k-iso', 'vs-v1');
    await expect(
      service.revoke('vs-v2', subscription.id, 'admin-1', 'Erreur'),
    ).rejects.toMatchObject({ status: 404 });
    expect((await service.verdictFor('vs-v1')).active).toBe(true);
  });

  it('une période terminée ne se révoque plus : 409', async () => {
    const past = new Date('2026-01-01T09:00:00Z');
    const { subscription } = await grant('k-old', 'vs-v1', past);
    await expect(
      service.revoke('vs-v1', subscription.id, 'admin-1', 'Trop tard'),
    ).rejects.toMatchObject({ status: 409 });
  });

  describe('révocation en partant du dernier mois — jamais de trou', () => {
    /** Les périodes actives forment-elles une suite sans trou ? */
    async function activeChain() {
      const active = await prisma.vendorSubscription.findMany({
        where: { restaurantId: 'vs-v1', status: 'ACTIVE' },
        orderBy: { startsAt: 'asc' },
      });
      for (let i = 1; i < active.length; i++) {
        expect(active[i].startsAt).toEqual(active[i - 1].endsAt);
      }
      return active;
    }

    it('un mois suivi d’un autre ne se révoque pas : 409, rien ne change', async () => {
      const first = (await grant('k-a')).subscription;
      await grant('k-b');

      await expect(
        service.revoke('vs-v1', first.id, 'admin-1', 'Paiement revenu'),
      ).rejects.toMatchObject({
        status: 409,
        message: expect.stringContaining('révoquez d’abord le mois suivant'),
      });
      expect(await activeChain()).toHaveLength(2);
    });

    it('le scénario de la revue : on révoque le dernier puis le premier, et un nouveau mois commence maintenant', async () => {
      const now = new Date();
      const first = (await grant('k-a', 'vs-v1', now)).subscription;
      const second = (await grant('k-b', 'vs-v1', now)).subscription;

      await service.revoke('vs-v1', second.id, 'admin-1', 'Paiement revenu');
      await service.revoke('vs-v1', first.id, 'admin-1', 'Paiement revenu');
      expect((await service.verdictFor('vs-v1')).active).toBe(false);

      // Le vendeur repaie : son mois commence tout de suite, pas après les
      // mois révoqués — aucun jour payé sans Premium.
      const paidAgain = new Date(now.getTime() + 60_000);
      const renewed = (await grant('k-c', 'vs-v1', paidAgain)).subscription;
      expect(renewed.startsAt).toEqual(paidAgain);

      const verdict = await service.verdictFor('vs-v1', paidAgain);
      expect(verdict.active).toBe(true);
      expect(verdict.paidUntil).toEqual(renewed.endsAt);
    });

    it('révocation et attribution simultanées : sérialisées, la suite reste continue', async () => {
      const current = (await grant('k-a')).subscription;

      const [revoked, granted] = await Promise.allSettled([
        service.revoke('vs-v1', current.id, 'admin-1', 'Erreur de saisie'),
        grant('k-b'),
      ]);
      expect(granted.status).toBe('fulfilled');
      // Selon l'ordre du verrou : la révocation passe la première (et le
      // nouveau mois commence maintenant), ou le nouveau mois s'empile
      // d'abord et la révocation est refusée en 409.
      if (revoked.status === 'rejected') {
        expect(revoked.reason).toMatchObject({ status: 409 });
      }
      const chain = await activeChain();
      expect(chain.length).toBeGreaterThanOrEqual(1);
      expect((await service.verdictFor('vs-v1')).paidUntil).toEqual(
        chain[chain.length - 1].endsAt,
      );
    });
  });

  it('expiré : redevient Standard sans aucune écriture', async () => {
    await grant('k-exp', 'vs-v1', new Date('2026-01-01T09:00:00Z'));
    const verdict = await service.verdictFor('vs-v1');
    expect(verdict.active).toBe(false);
    expect(verdict.entitlements).toEqual([]);
  });

  describe('CHECK en base', () => {
    const insert = (over: Record<string, string | null>) => {
      const row = {
        plan: "'PREMIUM'",
        status: "'ACTIVE'",
        method: "'CASH'",
        price: '15000',
        starts: "'2026-10-11 09:00'",
        ends: "'2026-11-11 09:00'",
        revokedAt: 'NULL',
        ...over,
      };
      return prisma.$executeRawUnsafe(`
        INSERT INTO "VendorSubscription"
          ("id","restaurantId","plan","status","startsAt","endsAt","priceXaf",
           "paymentMethod","requestKey","grantedById","revokedAt")
        VALUES (gen_random_uuid()::text, 'vs-v1', ${row.plan}, ${row.status},
          ${row.starts}, ${row.ends}, ${row.price}, ${row.method},
          gen_random_uuid()::text, 'admin-1', ${row.revokedAt})
      `);
    };

    it('ligne valide acceptée', async () => {
      await expect(insert({})).resolves.toBe(1);
    });
    it.each([
      ['formule inconnue', { plan: "'GOLD'" }],
      ['statut inconnu', { status: "'PAUSED'" }],
      ['moyen inconnu', { method: "'CHEQUE'" }],
      ['prix négatif', { price: '-1' }],
      ['fin avant début', { ends: "'2026-10-01 09:00'" }],
      ['REVOKED sans qui/quand/pourquoi', { status: "'REVOKED'" }],
      ['ACTIVE portant une révocation', { revokedAt: 'now()' }],
    ])('%s : refusé', async (_label, over) => {
      await expect(insert(over)).rejects.toThrow();
    });
  });
});
