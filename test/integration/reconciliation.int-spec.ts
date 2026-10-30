import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

import { reconciliationPayoutBlock } from '../../apps/lilia-app/src/modules/ledger/reconciliation-block';
import { ReconciliationService } from '../../apps/lilia-app/src/modules/ledger/reconciliation.service';
import { ProviderRow } from '../../apps/lilia-app/src/modules/ledger/reconciliation-rules';

/**
 * Lot 2 (30/10/2026) — rapprochement sur PostgreSQL réel.
 *
 *  · le même export ne s'importe qu'une fois (empreinte unique) ;
 *  · un écart n'est jamais dupliqué d'un passage à l'autre ;
 *  · un écart ouvert bloque les versements du bon périmètre (vendeur / tous) ;
 *  · résolu avec motif, il débloque ; revu avec d'autres montants, il rouvre ;
 *  · la base refuse une résolution sans motif et la réécriture du journal.
 *
 * Aucun appel prestataire : l'export est fourni, la base est locale.
 */
const DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

describeIfDb('Rapprochement (PostgreSQL réel)', () => {
  let prisma: PrismaClient;
  let service: ReconciliationService;
  const day = new Date('2026-10-20T00:00:00Z');
  const periodStart = day;
  const periodEnd = new Date('2026-10-21T00:00:00Z');
  const at = new Date('2026-10-20T10:00:00Z');

  beforeAll(async () => {
    prisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: DATABASE_URL }),
    });
    await prisma.$connect();
    service = new ReconciliationService(prisma as never);
  });

  beforeEach(async () => {
    // TRUNCATE contourne le trigger « ajout seul » (opération de test).
    await prisma.$executeRawUnsafe(
      `TRUNCATE TABLE "ReconciliationItemEvent", "ReconciliationItem", "ReconciliationRun", "LedgerEntry", "LedgerTransaction"`,
    );
    await prisma.$executeRawUnsafe(
      `TRUNCATE TABLE "Refund", "restaurant_payouts", "payments", "Order", "Restaurant", "User" RESTART IDENTITY CASCADE`,
    );
    await prisma.user.createMany({
      data: [
        {
          id: 'rc-o1',
          firebaseUid: 'fb-rc-o1',
          email: 'o1@t.local',
          role: 'RESTAURATEUR',
        },
        {
          id: 'rc-o2',
          firebaseUid: 'fb-rc-o2',
          email: 'o2@t.local',
          role: 'RESTAURATEUR',
        },
        { id: 'rc-c', firebaseUid: 'fb-rc-c', email: 'c@t.local' },
      ],
    });
    await prisma.restaurant.createMany({
      data: [
        {
          id: 'v1',
          nom: 'V1',
          adresse: 'Poto-Poto',
          phone: '060000001',
          ownerId: 'rc-o1',
        },
        {
          id: 'v2',
          nom: 'V2',
          adresse: 'Bacongo',
          phone: '060000002',
          ownerId: 'rc-o2',
        },
      ],
    });
    await prisma.order.create({
      data: {
        id: 'o1',
        restaurantId: 'v1',
        userId: 'rc-c',
        subTotal: 3000,
        deliveryFee: 1000,
        serviceFee: 450,
        total: 4450,
        paymentMethod: 'MTN_MOMO',
        status: 'LIVRER',
        deliveredAt: at,
      },
    });
    await prisma.payment.create({
      data: {
        id: 'p1',
        orderId: 'o1',
        amount: 4450,
        phoneNumber: '061234567',
        status: 'SUCCESS',
        provider: 'PAWAPAY',
        providerTransactionId: 'dep-1',
        completedAt: at,
      },
    });
  });

  afterAll(async () => {
    // Un écart laissé ouvert bloquerait les versements des suites suivantes.
    await prisma.$executeRawUnsafe(
      `TRUNCATE TABLE "ReconciliationItemEvent", "ReconciliationItem", "ReconciliationRun"`,
    );
    await prisma.$disconnect();
  });

  const row = (over: Partial<ProviderRow> = {}): ProviderRow => ({
    externalId: 'dep-1',
    kind: 'DEPOSIT',
    status: 'COMPLETED',
    amountXaf: 4450,
    currency: 'XAF',
    ...over,
  });
  const importRows = (rows: ProviderRow[], walletBalanceXaf?: number) =>
    service.importProviderExport({
      periodStart,
      periodEnd,
      rows,
      walletBalanceXaf,
      actorUserId: 'admin-1',
      now: at,
    });

  it('export concordant : aucun écart, aucun blocage', async () => {
    const r = await importRows([row()]);
    expect(r).toMatchObject({ duplicate: false, findings: 0 });
    expect(await reconciliationPayoutBlock(prisma, 'v1')).toBeNull();
  });

  it('le même export ne s’importe qu’une fois, quel que soit l’ordre des lignes', async () => {
    const extra = row({ externalId: 'dep-x', amountXaf: 500 });
    const a = await importRows([row(), extra]);
    const b = await importRows([extra, row()]);
    expect(b).toMatchObject({ duplicate: true, runId: a.runId });
    expect(await prisma.reconciliationRun.count()).toBe(1);
    expect(await prisma.reconciliationItem.count()).toBe(1);
  });

  it('encaissement inconnu de Lilia → bloque TOUS les versements', async () => {
    await importRows([row(), row({ externalId: 'dep-x', amountXaf: 500 })]);
    expect(await reconciliationPayoutBlock(prisma, 'v1')).toMatchObject({
      scope: 'GLOBAL',
      sampleType: 'PROVIDER_ONLY',
    });
    expect(await reconciliationPayoutBlock(prisma, 'v2')).toMatchObject({
      scope: 'GLOBAL',
    });
  });

  it('montant différent → bloque CE vendeur seulement', async () => {
    await importRows([row({ amountXaf: 4000 })]);
    expect(await reconciliationPayoutBlock(prisma, 'v1')).toMatchObject({
      scope: 'VENDOR',
      sampleType: 'AMOUNT_MISMATCH',
    });
    expect(await reconciliationPayoutBlock(prisma, 'v2')).toBeNull();
  });

  it('paiement réussi absent de l’export → LILIA_ONLY sur le vendeur', async () => {
    await importRows([]);
    const items = await prisma.reconciliationItem.findMany();
    expect(items.map((i) => i.type)).toEqual(['LILIA_ONLY']);
    expect(items[0]).toMatchObject({
      restaurantId: 'v1',
      blockScope: 'VENDOR',
    });
  });

  it('résolu avec motif → débloqué ; revu avec les mêmes montants → reste résolu ; montants changés → rouvert', async () => {
    await importRows([row({ amountXaf: 4000 })]);
    const item = await prisma.reconciliationItem.findFirstOrThrow();

    await expect(
      service.resolve({
        itemId: item.id,
        kind: 'EXPLAINED',
        note: 'court',
        actorUserId: 'admin-1',
      }),
    ).rejects.toThrow(/Motif obligatoire/);

    await service.resolve({
      itemId: item.id,
      kind: 'EXPLAINED',
      note: 'Frais opérateur prélevés à la source, confirmé par pawaPay',
      actorUserId: 'admin-1',
    });
    expect(await reconciliationPayoutBlock(prisma, 'v1')).toBeNull();

    // Même écart, autre export (wallet renseigné → autre empreinte).
    const same = await importRows([row({ amountXaf: 4000 })], 0);
    expect(same.duplicate).toBe(false);
    expect(
      (
        await prisma.reconciliationItem.findUniqueOrThrow({
          where: { id: item.id },
        })
      ).status,
    ).toBe('RESOLVED');

    const changed = await importRows([row({ amountXaf: 3900 })]);
    expect(changed.reopened).toBe(1);
    const reopened = await prisma.reconciliationItem.findUniqueOrThrow({
      where: { id: item.id },
      include: { events: { orderBy: { createdAt: 'asc' } } },
    });
    expect(reopened.status).toBe('OPEN');
    expect(reopened.resolutionNote).toBeNull();
    expect(reopened.events.map((e) => e.kind)).toEqual([
      'OPENED',
      'RESOLVED',
      'REOPENED',
    ]);
    expect(await reconciliationPayoutBlock(prisma, 'v1')).not.toBeNull();
  });

  it('deux résolutions simultanées : une seule passe', async () => {
    await importRows([row({ amountXaf: 4000 })]);
    const item = await prisma.reconciliationItem.findFirstOrThrow();
    const note = 'Écart expliqué par un doublon de saisie côté opérateur';
    const results = await Promise.allSettled([
      service.resolve({
        itemId: item.id,
        kind: 'EXPLAINED',
        note,
        actorUserId: 'a1',
      }),
      service.resolve({
        itemId: item.id,
        kind: 'EXPLAINED',
        note,
        actorUserId: 'a2',
      }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(
      await prisma.reconciliationItemEvent.count({
        where: { kind: 'RESOLVED' },
      }),
    ).toBe(1);
  });

  it('solde du wallet différent du grand livre → bloquant global', async () => {
    await importRows([row()], 999);
    const items = await prisma.reconciliationItem.findMany();
    expect(items.map((i) => i.type)).toEqual(['WALLET_BALANCE_MISMATCH']);
    expect(items[0]).toMatchObject({
      blockScope: 'GLOBAL',
      expectedXaf: 0,
      actualXaf: 999,
    });
  });

  it('versement en attente depuis plus de 24 h → STALE_IN_FLIGHT, vendeur bloqué', async () => {
    await prisma.restaurantPayout.create({
      data: {
        id: 'po-1',
        orderId: 'o1',
        restaurantId: 'v1',
        grossAmount: 3000,
        commissionPercent: 0,
        commissionAmount: 0,
        amount: 3000,
        phoneNumber: '242061234567',
        providerCode: 'MTN_MOMO',
        status: 'PENDING',
        providerPayoutId: 'payout-1',
        requestedAt: new Date('2026-10-18T10:00:00Z'),
      },
    });
    const r = await service.scanInternal({ actorUserId: 'admin-1', now: at });
    expect(r.opened).toBe(1);
    const item = await prisma.reconciliationItem.findFirstOrThrow();
    expect(item).toMatchObject({
      type: 'STALE_IN_FLIGHT',
      itemKey: 'STALE_IN_FLIGHT:payout:po-1',
      blockScope: 'VENDOR',
      restaurantId: 'v1',
    });
    // Rejouer le passage n'ajoute rien.
    await service.scanInternal({ actorUserId: 'admin-1', now: at });
    expect(await prisma.reconciliationItem.count()).toBe(1);
  });

  describe('garanties de la base', () => {
    it('refuse une résolution sans motif écrite à la main', async () => {
      await importRows([row({ amountXaf: 4000 })]);
      await expect(
        prisma.$executeRaw`UPDATE "ReconciliationItem" SET status = 'RESOLVED', "resolvedAt" = now(), "resolvedBy" = 'x', "resolutionKind" = 'EXPLAINED'`,
      ).rejects.toThrow(/ReconciliationItem_resolution_complete/);
    });

    it('refuse un blocage « vendeur » sans vendeur', async () => {
      await expect(
        prisma.reconciliationItem.create({
          data: {
            itemKey: 'x',
            type: 'AMOUNT_MISMATCH',
            severity: 'CRITICAL',
            blockScope: 'VENDOR',
            detail: 'x',
          },
        }),
      ).rejects.toThrow(/ReconciliationItem_vendor_block_has_vendor/);
    });

    it('journal en ajout seul', async () => {
      await importRows([row({ amountXaf: 4000 })]);
      await expect(
        prisma.$executeRaw`UPDATE "ReconciliationItemEvent" SET note = 'réécrit'`,
      ).rejects.toThrow(/interdit/);
      await expect(
        prisma.$executeRaw`DELETE FROM "ReconciliationItemEvent"`,
      ).rejects.toThrow(/interdit/);
    });
  });
});
