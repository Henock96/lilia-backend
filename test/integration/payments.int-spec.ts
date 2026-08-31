import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

/**
 * Anti-double-débit, prouvé sur un vrai PostgreSQL.
 *
 * `docs/PAYMENTS.md` affirme que **la base arbitre le double clic, pas un
 * `if`**. C'est une affirmation sur des contraintes SQL — et aucun test unitaire
 * ne peut l'établir : ils mockent tous Prisma, donc ils vérifient qu'on
 * *appelle* la bonne requête, jamais qu'elle *tient*. Un mock à qui l'on dit de
 * renvoyer `P2002` renvoie `P2002` ; il ne démontre rien.
 *
 * Ce fichier exécute les vraies requêtes, réellement en parallèle, contre les
 * index réellement créés par les migrations :
 *
 * ```sql
 * CREATE UNIQUE INDEX payments_order_pending_uq
 *     ON payments ("orderId") WHERE status = 'PENDING';
 * CREATE UNIQUE INDEX payments_provider_tx_uq
 *     ON payments (provider, "providerTransactionId")
 *     WHERE "providerTransactionId" IS NOT NULL;
 * ALTER TABLE restaurant_payouts ADD CONSTRAINT … UNIQUE ("orderId");
 * ```
 *
 * Se saute proprement sans `TEST_DATABASE_URL`, comme les autres intégrations.
 */
const DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

describeIfDb('Paiements — garanties portées par PostgreSQL', () => {
  let prisma: PrismaClient;

  beforeAll(async () => {
    prisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: DATABASE_URL }),
    });
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(`
      TRUNCATE TABLE "PaymentEvent", "restaurant_payouts", "DeliveryReview",
                     "DeliveryLocation", "Delivery", "LoyaltyTransaction",
                     "OrderItem", "OrderHistory", "payments", "Refund",
                     "Order", "CartItem", "Cart", "ProductVariant", "Product",
                     "Restaurant", "User"
      RESTART IDENTITY CASCADE
    `);

    await prisma.user.createMany({
      data: [
        { id: 'client-1', firebaseUid: 'fb-c1', email: 'c1@test.local' },
        {
          id: 'admin-1',
          firebaseUid: 'fb-a1',
          email: 'a1@test.local',
          role: 'ADMIN',
        },
      ],
    });
    await prisma.restaurant.create({
      data: {
        id: 'resto-1',
        nom: 'Chez Awa',
        adresse: 'Bacongo',
        phone: '060000000',
        ownerId: 'client-1',
        payoutPhoneNumber: '242060000000',
        payoutProvider: 'MTN_MOMO',
      },
    });
    await prisma.order.createMany({
      data: [
        {
          id: 'order-1',
          restaurantId: 'resto-1',
          userId: 'client-1',
          subTotal: 5000,
          deliveryFee: 1000,
          serviceFee: 400,
          total: 6400,
          paymentMethod: 'MTN_MOMO',
        },
        {
          id: 'order-2',
          restaurantId: 'resto-1',
          userId: 'client-1',
          subTotal: 5000,
          deliveryFee: 1000,
          serviceFee: 400,
          total: 6400,
          paymentMethod: 'MTN_MOMO',
        },
      ],
    });
  });

  /** L'insertion réelle de `acquireOrReusePendingPayment`. */
  const openPayment = (orderId: string, providerTransactionId: string) =>
    prisma.payment.create({
      data: {
        orderId,
        amount: 6400,
        currency: 'XAF',
        phoneNumber: '242060000000',
        method: 'MTN_MOMO',
        status: 'PENDING',
        provider: 'PAWAPAY',
        providerTransactionId,
      },
    });

  // ══════════════════════════════════════════════════════════════════════════
  describe('encaissement — un seul débit', () => {
    it('double clic : deux insertions concurrentes, une seule ligne PENDING', async () => {
      const results = await Promise.allSettled([
        openPayment('order-1', 'uuid-a'),
        openPayment('order-1', 'uuid-b'),
      ]);

      const ok = results.filter((r) => r.status === 'fulfilled');
      const ko = results.filter((r) => r.status === 'rejected');

      expect(ok).toHaveLength(1);
      expect(ko).toHaveLength(1);
      // C'est bien la contrainte d'unicité qui a tranché, pas une erreur
      // quelconque : si ce code changeait, `PaymentService` ne saurait plus
      // reconnaître la course et créerait une seconde demande.
      expect((ko[0] as PromiseRejectedResult).reason).toMatchObject({
        code: 'P2002',
      });

      const rows = await prisma.payment.findMany({
        where: { orderId: 'order-1' },
      });
      expect(rows).toHaveLength(1);
    });

    it('l’index est PARTIEL : après un échec, une nouvelle tentative passe', async () => {
      const first = await openPayment('order-1', 'uuid-a');
      await prisma.payment.update({
        where: { id: first.id },
        data: { status: 'FAILED', completedAt: new Date() },
      });

      // Sans la clause `WHERE status = 'PENDING'`, cette insertion échouerait
      // et un client dont le paiement a échoué ne pourrait plus jamais payer.
      await expect(openPayment('order-1', 'uuid-b')).resolves.toMatchObject({
        status: 'PENDING',
      });

      const rows = await prisma.payment.findMany({
        where: { orderId: 'order-1' },
      });
      expect(rows).toHaveLength(2);
    });

    it('l’index est par COMMANDE : deux commandes se paient en parallèle', async () => {
      const results = await Promise.allSettled([
        openPayment('order-1', 'uuid-a'),
        openPayment('order-2', 'uuid-b'),
      ]);
      expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    });

    it('la référence prestataire est unique : un webhook ne peut pas viser deux paiements', async () => {
      await openPayment('order-1', 'uuid-partagee');

      await expect(
        openPayment('order-2', 'uuid-partagee'),
      ).rejects.toMatchObject({ code: 'P2002' });
    });

    it('deux « workers » confirment le même paiement : un seul réclame la ligne', async () => {
      const payment = await openPayment('order-1', 'uuid-a');

      // La requête réelle de `confirmCollection` : le premier statut terminal
      // gagne, et il gagne parce que la condition est DANS le UPDATE.
      const claim = () =>
        prisma.payment.updateMany({
          where: { id: payment.id, status: 'PENDING' },
          data: { status: 'SUCCESS', completedAt: new Date() },
        });

      const [a, b] = await Promise.all([claim(), claim()]);

      expect([a.count, b.count].filter((n) => n === 1)).toHaveLength(1);
      expect([a.count, b.count].filter((n) => n === 0)).toHaveLength(1);
    });

    it('un FAILED tardif ne défait pas un encaissement confirmé', async () => {
      const payment = await openPayment('order-1', 'uuid-a');
      await prisma.payment.updateMany({
        where: { id: payment.id, status: 'PENDING' },
        data: { status: 'SUCCESS', completedAt: new Date() },
      });

      const late = await prisma.payment.updateMany({
        where: { id: payment.id, status: 'PENDING' },
        data: { status: 'FAILED' },
      });

      expect(late.count).toBe(0);
      const row = await prisma.payment.findUniqueOrThrow({
        where: { id: payment.id },
      });
      expect(row.status).toBe('SUCCESS');
    });

    it('la commande n’est réclamée qu’une fois : pas de double notification vendeur', async () => {
      // `order.updateMany WHERE status = 'EN_ATTENTE'` — c'est cette condition
      // qui décide si l'outbox `order.paid` est enfilé.
      const claim = () =>
        prisma.order.updateMany({
          where: { id: 'order-1', status: 'EN_ATTENTE' },
          data: { status: 'PAYER', paidAt: new Date() },
        });

      const [a, b] = await Promise.all([claim(), claim()]);
      expect([a.count, b.count].filter((n) => n === 1)).toHaveLength(1);
    });

    it('une commande annulée n’est jamais ressuscitée par un encaissement tardif', async () => {
      await prisma.order.update({
        where: { id: 'order-1' },
        data: { status: 'ANNULER' },
      });

      const claimed = await prisma.order.updateMany({
        where: { id: 'order-1', status: 'EN_ATTENTE' },
        data: { status: 'PAYER', paidAt: new Date() },
      });

      expect(claimed.count).toBe(0);
      const order = await prisma.order.findUniqueOrThrow({
        where: { id: 'order-1' },
      });
      expect(order.status).toBe('ANNULER');
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  describe('reversement — un seul virement', () => {
    const openPayout = (orderId: string, providerPayoutId: string) =>
      prisma.restaurantPayout.create({
        data: {
          orderId,
          restaurantId: 'resto-1',
          grossAmount: 5000,
          commissionPercent: 10,
          commissionAmount: 500,
          amount: 4500,
          currency: 'XAF',
          phoneNumber: '242060000000',
          providerCode: 'MTN_MOMO',
          status: 'PENDING',
          provider: 'PAWAPAY',
          providerPayoutId,
          requestedBy: 'admin-1',
        },
      });

    it('deux administrateurs cliquent en même temps : un seul reversement', async () => {
      const results = await Promise.allSettled([
        openPayout('order-1', 'payout-a'),
        openPayout('order-1', 'payout-b'),
      ]);

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);

      const rows = await prisma.restaurantPayout.findMany({
        where: { orderId: 'order-1' },
      });
      expect(rows).toHaveLength(1);
    });

    it('⚠️ l’unicité est ABSOLUE, pas partielle : même après un échec, la ligne bloque', async () => {
      const first = await openPayout('order-1', 'payout-a');
      await prisma.restaurantPayout.update({
        where: { id: first.id },
        data: { status: 'FAILED', failureCode: 'REJECTED' },
      });

      // C'est exactement pourquoi `retryPayout` SUPPRIME la ligne échouée avant
      // de rappeler `requestPayout` : contrairement aux encaissements, l'index
      // n'est pas conditionné au statut. Une reprise « par insertion » comme
      // côté client échouerait ici.
      await expect(openPayout('order-1', 'payout-b')).rejects.toMatchObject({
        code: 'P2002',
      });

      await prisma.restaurantPayout.deleteMany({ where: { id: first.id } });
      await expect(openPayout('order-1', 'payout-b')).resolves.toMatchObject({
        status: 'PENDING',
      });
    });

    it('deux « workers » confirment le même reversement : un seul réclame la ligne', async () => {
      const payout = await openPayout('order-1', 'payout-a');

      const claim = () =>
        prisma.restaurantPayout.updateMany({
          where: { id: payout.id, status: 'PENDING' },
          data: { status: 'SUCCESS', completedAt: new Date() },
        });

      const [a, b] = await Promise.all([claim(), claim()]);
      expect([a.count, b.count].filter((n) => n === 1)).toHaveLength(1);
    });

    it('une reprise concurrente ne supprime pas un reversement qui a changé d’état', async () => {
      const payout = await openPayout('order-1', 'payout-a');
      await prisma.restaurantPayout.update({
        where: { id: payout.id },
        data: { status: 'FAILED' },
      });

      // `retryPayout` supprime en conditionnant sur le statut lu. Si la
      // réconciliation l'a fait passer SUCCESS entre-temps, la suppression ne
      // doit rien effacer — sinon on repartirait sur un virement déjà parti.
      await prisma.restaurantPayout.update({
        where: { id: payout.id },
        data: { status: 'SUCCESS' },
      });

      const deleted = await prisma.restaurantPayout.deleteMany({
        where: { id: payout.id, status: 'FAILED' },
      });

      expect(deleted.count).toBe(0);
      const row = await prisma.restaurantPayout.findUniqueOrThrow({
        where: { id: payout.id },
      });
      expect(row.status).toBe('SUCCESS');
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  /**
   * Le journal doit survivre à ce qu'il documente. `PaymentEvent` porte
   * `onDelete: SetNull` sur ses deux relations, précisément pour qu'une reprise
   * de reversement — qui supprime la ligne échouée — n'efface pas la preuve de
   * l'échec.
   */
  describe('journal des signaux', () => {
    it('supprimer un reversement ne détruit pas son journal', async () => {
      const payout = await prisma.restaurantPayout.create({
        data: {
          orderId: 'order-1',
          restaurantId: 'resto-1',
          grossAmount: 5000,
          commissionPercent: 10,
          commissionAmount: 500,
          amount: 4500,
          phoneNumber: '242060000000',
          providerCode: 'MTN_MOMO',
          status: 'FAILED',
          provider: 'PAWAPAY',
          providerPayoutId: 'payout-a',
          requestedBy: 'admin-1',
        },
      });
      await prisma.paymentEvent.create({
        data: {
          payoutId: payout.id,
          kind: 'PAYOUT',
          provider: 'PAWAPAY',
          externalId: 'payout-a',
          source: 'WEBHOOK',
          rawStatus: 'FAILED',
          payload: {},
          outcome: 'APPLIED',
        },
      });

      await prisma.restaurantPayout.delete({ where: { id: payout.id } });

      const events = await prisma.paymentEvent.findMany({
        where: { provider: 'PAWAPAY', externalId: 'payout-a' },
      });
      expect(events).toHaveLength(1);
      // ⚠️ Le lien est rompu : l'événement reste retrouvable par sa référence
      // prestataire, mais plus par `payoutId` — donc invisible depuis
      // `GET /admin/payouts/:id/events` après une reprise.
      expect(events[0].payoutId).toBeNull();
    });
  });
});
