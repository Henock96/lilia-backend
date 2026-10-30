import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

import { LedgerService } from '../../apps/lilia-app/src/modules/ledger/ledger.service';
import { LedgerPosterService } from '../../apps/lilia-app/src/modules/ledger/ledger-poster.service';
import { collectionPosting } from '../../apps/lilia-app/src/modules/ledger/ledger-postings';

/**
 * Lot 2 (30/10/2026) — le grand livre sur PostgreSQL réel.
 *
 * Ce que la base garantit elle-même (pas seulement le code) :
 *  · une transaction déséquilibrée ou à une ligne n'est jamais engagée ;
 *  · UPDATE et DELETE sont refusés ;
 *  · un compte inconnu est refusé.
 *
 * Ce que le posteur garantit :
 *  · chaque fait source est écrit une fois, même rejoué ou lancé en double ;
 *  · les soldes reconstruits sont ceux attendus (vendeur soldé après
 *    versement, argent rendu sur une commande annulée) ;
 *  · une commande exclue (test) n'est pas écrite ;
 *  · un fait incohérent part en exception, rien n'est forcé ;
 *  · la reprise historique marque ses écritures `BACKFILL`.
 *
 * Aucun appel à un prestataire : seules des lignes déjà en base sont lues.
 */
const DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

describeIfDb('Grand livre (PostgreSQL réel)', () => {
  let prisma: PrismaClient;
  let ledger: LedgerService;
  let poster: LedgerPosterService;
  const at = new Date('2026-10-20T10:00:00Z');

  beforeAll(async () => {
    prisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: DATABASE_URL }),
    });
    await prisma.$connect();
    ledger = new LedgerService(prisma as never);
    poster = new LedgerPosterService(prisma as never, ledger);
  });

  beforeEach(async () => {
    // TRUNCATE reste possible (opération d'exploitation) : UPDATE/DELETE non.
    await prisma.$executeRawUnsafe(
      `TRUNCATE TABLE "LedgerEntry", "LedgerTransaction", "LedgerPostingException", "LedgerExcludedOrder"`,
    );
    await prisma.$executeRawUnsafe(
      `TRUNCATE TABLE "Refund", "restaurant_payouts", "payments", "Order", "Restaurant", "User" RESTART IDENTITY CASCADE`,
    );
    await prisma.user.createMany({
      data: [
        {
          id: 'lg-owner',
          firebaseUid: 'fb-lg-o',
          email: 'lg-o@t.local',
          role: 'RESTAURATEUR',
        },
        { id: 'lg-client', firebaseUid: 'fb-lg-c', email: 'lg-c@t.local' },
      ],
    });
    await prisma.restaurant.create({
      data: {
        id: 'lg-v',
        nom: 'Chez Livre',
        adresse: 'Poto-Poto',
        phone: '060000099',
        ownerId: 'lg-owner',
      },
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  /** Commande type : 3 000 + 1 000 + 450 − 200 = 4 250, commission 0 %. */
  const order = (id: string, status: 'LIVRER' | 'ANNULER') =>
    prisma.order.create({
      data: {
        id,
        restaurantId: 'lg-v',
        userId: 'lg-client',
        subTotal: 3000,
        deliveryFee: 1000,
        serviceFee: 450,
        discountAmount: 200,
        total: 4250,
        commissionPercent: 0,
        paymentMethod: 'MTN_MOMO',
        status,
        deliveredAt: status === 'LIVRER' ? at : null,
      },
    });
  const payment = (id: string, orderId: string, amount = 4250) =>
    prisma.payment.create({
      data: {
        id,
        orderId,
        amount,
        phoneNumber: '061234567',
        status: 'SUCCESS',
        provider: 'PAWAPAY',
        providerTransactionId: `dep-${id}`,
        completedAt: at,
      },
    });

  const balance = async (account: string, subjectId?: string) => {
    const agg = await prisma.ledgerEntry.aggregate({
      where: { account, ...(subjectId ? { subjectId } : {}) },
      _sum: { amountXaf: true },
    });
    return agg._sum.amountXaf ?? 0;
  };

  describe('garanties de la base', () => {
    it('refuse une transaction déséquilibrée, au COMMIT', async () => {
      await expect(
        prisma.$transaction((tx) =>
          tx.ledgerTransaction.create({
            data: {
              kind: 'COLLECTION',
              sourceType: 'Payment',
              sourceId: 'x',
              sourceEventKey: 'payment:x:success',
              origin: 'SYSTEM',
              occurredAt: at,
              entries: {
                create: [
                  { account: 'psp:PAWAPAY', amountXaf: 100 },
                  {
                    account: 'clearing:order',
                    subjectType: 'ORDER',
                    subjectId: 'o',
                    amountXaf: -99,
                  },
                ],
              },
            },
          }),
        ),
      ).rejects.toThrow(/déséquilibrée/);
      expect(await prisma.ledgerTransaction.count()).toBe(0);
    });

    it('refuse une transaction à une seule ligne', async () => {
      await expect(
        prisma.$transaction((tx) =>
          tx.ledgerTransaction.create({
            data: {
              kind: 'COLLECTION',
              sourceType: 'Payment',
              sourceId: 'x',
              sourceEventKey: 'payment:x:success',
              origin: 'SYSTEM',
              occurredAt: at,
              entries: { create: [{ account: 'psp:PAWAPAY', amountXaf: 100 }] },
            },
          }),
        ),
      ).rejects.toThrow(/au moins 2/);
    });

    it('refuse un compte inconnu', async () => {
      await expect(
        ledger.post({
          ...collectionPosting({
            payment: {
              id: 'p',
              orderId: 'o',
              provider: 'PAWAPAY',
              amount: 10,
              completedAt: at,
              providerTransactionId: null,
            },
            origin: 'SYSTEM',
          }),
          lines: [
            { account: 'banque:secrete' as never, amountXaf: 10 },
            {
              account: 'clearing:order',
              subjectType: 'ORDER',
              subjectId: 'o',
              amountXaf: -10,
            },
          ],
        }),
      ).rejects.toThrow(/LedgerEntry_account_known/);
    });

    it('ajout seul : UPDATE et DELETE refusés', async () => {
      await order('o-1', 'LIVRER');
      await payment('p-1', 'o-1');
      await poster.catchUp();
      await expect(
        prisma.$executeRaw`UPDATE "LedgerEntry" SET "amountXaf" = 1`,
      ).rejects.toThrow(/interdit/);
      await expect(
        prisma.$executeRaw`DELETE FROM "LedgerTransaction"`,
      ).rejects.toThrow(/interdit/);
    });
  });

  describe('posteur', () => {
    it('livrée puis versée : vendeur soldé, transit à zéro, rejouer n’écrit rien', async () => {
      await order('o-1', 'LIVRER');
      await payment('p-1', 'o-1');
      await prisma.restaurantPayout.create({
        data: {
          id: 'po-1',
          orderId: 'o-1',
          restaurantId: 'lg-v',
          grossAmount: 3000,
          commissionPercent: 0,
          commissionAmount: 0,
          amount: 3000,
          phoneNumber: '242061234567',
          providerCode: 'MTN_MOMO',
          status: 'SUCCESS',
          providerPayoutId: 'payout-po-1',
          completedAt: at,
        },
      });

      const first = await poster.catchUp();
      expect(first.collections.posted).toBe(1);
      expect(first.acquisitions.posted).toBe(1);
      expect(first.payouts.posted).toBe(1);

      expect(await balance('vendor_payable', 'lg-v')).toBe(0);
      expect(await balance('clearing:order', 'o-1')).toBe(0);
      expect(await balance('psp:PAWAPAY')).toBe(4250 - 3000);
      expect(await balance('expense:platform_discount')).toBe(200);
      expect(await ledger.vendorBalance('lg-v')).toBe(0);

      const second = await poster.catchUp();
      expect(Object.values(second).reduce((s, r) => s + r.posted, 0)).toBe(0);
      expect(await prisma.ledgerTransaction.count()).toBe(3);
    });

    it('deux posteurs en même temps : chaque fait une seule fois', async () => {
      await order('o-1', 'LIVRER');
      await payment('p-1', 'o-1');
      await Promise.all([poster.catchUp(), poster.catchUp(), poster.catchUp()]);
      expect(await prisma.ledgerTransaction.count()).toBe(2);
      expect(await balance('psp:PAWAPAY')).toBe(4250);
    });

    it('annulée et remboursée par le prestataire : rien ne reste', async () => {
      await order('o-2', 'ANNULER');
      await payment('p-2', 'o-2');
      await prisma.refund.create({
        data: {
          orderId: 'o-2',
          amount: 4250,
          reason: 'annulation',
          status: 'COMPLETED',
          provider: 'PAWAPAY',
          providerRefundId: 'rf-1',
          providerTransactionId: 'tx-rf-1',
          closureMethod: 'PROVIDER',
          processedAt: at,
        },
      });
      await poster.catchUp();
      expect(await balance('clearing:order', 'o-2')).toBe(0);
      expect(await balance('psp:PAWAPAY')).toBe(0);
    });

    it('commande exclue (test) : rien n’est écrit, elle est comptée à part', async () => {
      await order('o-test', 'LIVRER');
      await payment('p-test', 'o-test');
      await prisma.ledgerExcludedOrder.create({
        data: {
          orderId: 'o-test',
          reason: 'commande de test',
          createdBy: 'admin',
        },
      });
      const r = await poster.catchUp();
      expect(await prisma.ledgerTransaction.count()).toBe(0);
      expect(r.collections.excluded + r.acquisitions.excluded).toBe(2);
    });

    it('fait incohérent : exception consignée, aucune écriture forcée', async () => {
      // Total plafonné à 0 par des remises supérieures au montant.
      await prisma.order.create({
        data: {
          id: 'o-bad',
          restaurantId: 'lg-v',
          userId: 'lg-client',
          subTotal: 1000,
          deliveryFee: 0,
          serviceFee: 150,
          discountAmount: 5000,
          total: 0,
          paymentMethod: 'MTN_MOMO',
          status: 'LIVRER',
          deliveredAt: at,
        },
      });
      const r = await poster.catchUp();
      expect(r.acquisitions.exceptions).toBe(1);
      expect(await prisma.ledgerTransaction.count()).toBe(0);
      const exc = await prisma.ledgerPostingException.findUniqueOrThrow({
        where: { sourceEventKey: 'order:o-bad:acquired' },
      });
      expect(exc.reason).toBe('TOTAL_INCONSISTENT');
    });

    it('reprise historique : écritures marquées BACKFILL, frais inconnus non écrits', async () => {
      await order('o-1', 'LIVRER');
      await payment('p-1', 'o-1'); // collectionFeeXaf = null : inconnu
      await poster.catchUp({
        backfillBefore: new Date('2026-10-29T00:00:00Z'),
      });
      const modes = await prisma.ledgerTransaction.findMany({
        select: { postingMode: true },
      });
      expect(modes.every((m) => m.postingMode === 'BACKFILL')).toBe(true);
      expect(await balance('expense:psp_fee')).toBe(0);
    });

    it('contre-passation : une seule, et le solde revient à zéro', async () => {
      await order('o-1', 'LIVRER');
      await payment('p-1', 'o-1');
      await poster.catchUp();
      const tx = await prisma.ledgerTransaction.findUniqueOrThrow({
        where: { sourceEventKey: 'payment:p-1:success' },
      });
      const a = await ledger.reverse({
        txId: tx.id,
        reason: 'doublon',
        actorUserId: 'admin-1',
      });
      const b = await ledger.reverse({
        txId: tx.id,
        reason: 'doublon',
        actorUserId: 'admin-1',
      });
      expect(a.outcome).toBe('POSTED');
      expect(b.outcome).toBe('DUPLICATE');
      // L'encaissement contre-passé ; l'acquisition reste : clearing = +4 250.
      expect(await balance('psp:PAWAPAY')).toBe(0);
    });
  });
});
