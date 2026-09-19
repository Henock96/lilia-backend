import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

import { DriverSettlementService } from '../../apps/lilia-app/src/modules/drivers/driver-settlement.service';

/**
 * **Le règlement du livreur, contre un vrai PostgreSQL.**
 *
 * Ce que les tests unitaires ne peuvent pas prouver ici : que la BASE refuse
 * réellement de rattacher deux fois la même course. Le service s'appuie sur un
 * `updateMany WHERE driverSettlementId IS NULL` et compare le compte obtenu à
 * celui attendu — un mock rend ce qu'on lui dit de rendre, et validerait donc
 * une protection inexistante.
 *
 * Le dernier cas joue **deux enregistrements concurrents**. C'est le scénario
 * qui coûte de l'argent : deux administrateurs qui règlent le même livreur en
 * même temps.
 *
 * Se saute proprement sans `TEST_DATABASE_URL`.
 */
const DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

describeIfDb('Règlement livreur — verrou et concurrence', () => {
  let prisma: PrismaClient;
  let settlements: DriverSettlementService;

  const OWNER = 'ds-owner';
  const CLIENT = 'ds-client';
  const DRIVER = 'ds-driver';
  const VENDOR = 'ds-vendor';
  const LATE = new Date('2026-09-30T00:00:00Z');

  /** Crée une commande livrée et sa course, avec une économie gelée. */
  const deliveredCourse = async (
    n: number,
    payXaf: number,
    deliveredAt: string,
  ) => {
    await prisma.order.create({
      data: {
        id: `ds-o${n}`,
        restaurantId: VENDOR,
        userId: CLIENT,
        subTotal: 5000,
        deliveryFee: 1000,
        deliveryFeeGross: 1000,
        serviceFee: 750,
        total: 6750,
        paymentMethod: 'MTN_MOMO',
        status: 'LIVRER',
      },
    });
    await prisma.delivery.create({
      data: {
        id: `ds-d${n}`,
        orderId: `ds-o${n}`,
        delivererId: DRIVER,
        status: 'LIVRER',
        deliveredAt: new Date(deliveredAt),
        driverBaseXaf: 1000,
        driverPayXaf: payXaf,
        driverSharePercent: 35,
        driverEmploymentType: 'LILIA',
        driverCompensationModel: 'PER_DELIVERY',
        driverEconomicsFrozenAt: new Date(deliveredAt),
      },
    });
  };

  beforeAll(async () => {
    prisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: DATABASE_URL }),
    });
    await prisma.$connect();
    settlements = new DriverSettlementService(prisma as never);

    await prisma.$executeRawUnsafe(`
      TRUNCATE TABLE "PaymentEvent", "restaurant_payouts", "OutboxEvent",
                     "Incident", "DeliveryReview", "DeliveryLocation",
                     "Delivery", "driver_settlements", "LoyaltyTransaction",
                     "OrderItem", "OrderHistory", "payments", "Refund", "Order",
                     "CartItem", "Cart", "ProductVariant", "Product",
                     "DriverProfile", "Restaurant", "User", "PlatformSettings"
      RESTART IDENTITY CASCADE
    `);

    await prisma.user.createMany({
      data: [
        { id: CLIENT, firebaseUid: 'fb-ds-c', email: 'ds-c@test.local' },
        {
          id: OWNER,
          firebaseUid: 'fb-ds-o',
          email: 'ds-o@test.local',
          role: 'RESTAURATEUR',
        },
        {
          id: DRIVER,
          firebaseUid: 'fb-ds-d',
          email: 'ds-d@test.local',
          role: 'LIVREUR',
        },
      ],
    });
    await prisma.restaurant.create({
      data: {
        id: VENDOR,
        nom: 'Chez Maman Test',
        adresse: 'Poto-Poto',
        phone: '060000008',
        ownerId: OWNER,
      },
    });

    await deliveredCourse(1, 350, '2026-09-19T08:00:00Z');
    await deliveredCourse(2, 650, '2026-09-19T10:00:00Z');
    await deliveredCourse(3, 117, '2026-09-19T14:00:00Z');
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('1. le dû se lit, et la lecture n’écrit rien', async () => {
    const before = await prisma.driverSettlement.count();

    const out = await settlements.getOutstanding(DRIVER, LATE);

    expect(out.amountXaf).toBe(1117);
    expect(out.courseCount).toBe(3);
    expect(await prisma.driverSettlement.count()).toBe(before);
    // Aucune course n'est immobilisée par une simple consultation.
    expect(
      await prisma.delivery.count({
        where: { driverSettlementId: { not: null } },
      }),
    ).toBe(0);
  });

  it('2. la coupure exclut réellement les courses postérieures', async () => {
    // Coupure à 09:00 : seule la course de 08:00 entre.
    const out = await settlements.getOutstanding(
      DRIVER,
      new Date('2026-09-19T09:00:00Z'),
    );

    expect(out.courseCount).toBe(1);
    expect(out.amountXaf).toBe(350);
  });

  it('3. enregistrer fige le montant et rattache les courses', async () => {
    const s = await settlements.record({
      driverId: DRIVER,
      coveredUntil: new Date('2026-09-19T11:00:00Z'),
      method: 'CASH',
      adminId: 'admin-1',
    });

    expect(s.amountXaf).toBe(1000); // 350 + 650, pas la course de 14 h
    expect(s.courseCount).toBe(2);
    expect(s.status).toBe('PAID');

    const attached = await prisma.delivery.findMany({
      where: { driverSettlementId: s.id },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    expect(attached.map((d) => d.id)).toEqual(['ds-d1', 'ds-d2']);
  });

  it('4. les courses réglées sortent du dû — pas de double paiement', async () => {
    const out = await settlements.getOutstanding(DRIVER, LATE);

    // Reste la seule course non couverte.
    expect(out.courseCount).toBe(1);
    expect(out.amountXaf).toBe(117);
  });

  it('5. le montant figé est exactement la somme des courses couvertes', async () => {
    const s = await prisma.driverSettlement.findFirstOrThrow({
      where: { driverId: DRIVER, status: 'PAID' },
    });
    const covered = await prisma.delivery.findMany({
      where: { driverSettlementId: s.id },
      select: { driverPayXaf: true },
    });

    expect(covered.reduce((t, c) => t + (c.driverPayXaf ?? 0), 0)).toBe(
      s.amountXaf,
    );
    expect(covered).toHaveLength(s.courseCount);
  });

  /**
   * ⚠️ **Ce que ce test prouve, et ce qu'il ne prouve pas.**
   *
   * Il constate qu'après deux appels simultanés, le livreur est payé une fois
   * et une seule — le résultat qui compte. Il ne prouve **pas** que le verrou
   * de base en soit la cause : vérifié en retirant
   * `driverSettlementId: null` du `where`, il reste vert. Les deux appels se
   * sérialisent à travers le pool de connexions, et le second trouve alors
   * zéro course à régler ; il échoue, mais pour une autre raison.
   *
   * C'est exactement le piège que ce dépôt connaît bien : une sonde qui rend
   * le bon verdict sans mesurer ce qu'on croit. Le verrou lui-même est éprouvé
   * par le test suivant, qui attaque la primitive SQL directement.
   */
  it('6. deux règlements simultanés : le livreur est payé une seule fois', async () => {
    const attempt = () =>
      settlements.record({
        driverId: DRIVER,
        coveredUntil: LATE,
        method: 'MOBILE_MONEY',
        adminId: 'admin-concurrent',
      });

    const results = await Promise.allSettled([attempt(), attempt()]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);

    // Et surtout : la course n'est couverte qu'UNE fois.
    const d3 = await prisma.delivery.findUniqueOrThrow({
      where: { id: 'ds-d3' },
    });
    expect(d3.driverSettlementId).not.toBeNull();

    const paid = await prisma.driverSettlement.findMany({
      where: { driverId: DRIVER, status: 'PAID' },
    });
    expect(paid.reduce((t, s) => t + s.amountXaf, 0)).toBe(1117);
  });

  /**
   * Le verrou, attaqué directement.
   *
   * C'est la garantie sur laquelle tout repose : deux transactions qui
   * revendiquent les mêmes courses, une seule les obtient. On joue ici le
   * `updateMany` exact du service, sans passer par lui — même approche que
   * `concurrency.int-spec.ts` pour le double-tap d'acceptation.
   *
   * Sans `driverSettlementId: null` dans le `where`, les deux comptes valent 1
   * et ce test échoue.
   */
  it('6b. le verrou de base : deux revendications, une seule aboutit', async () => {
    const [decoyA, decoyB] = await Promise.all([
      prisma.driverSettlement.create({
        data: {
          driverId: DRIVER,
          amountXaf: 0,
          courseCount: 0,
          periodStart: LATE,
          coveredUntil: LATE,
          method: 'CASH',
          paidAt: LATE,
          recordedBy: 'admin-a',
        },
      }),
      prisma.driverSettlement.create({
        data: {
          driverId: DRIVER,
          amountXaf: 0,
          courseCount: 0,
          periodStart: LATE,
          coveredUntil: LATE,
          method: 'CASH',
          paidAt: LATE,
          recordedBy: 'admin-b',
        },
      }),
    ]);

    // La course visée est déjà couverte par le règlement du test 6 : on note
    // son rattachement d'origine, puis on la libère pour la rendre
    // revendiquable.
    const original = await prisma.delivery.findUniqueOrThrow({
      where: { id: 'ds-d3' },
      select: { driverSettlementId: true },
    });
    await prisma.delivery.update({
      where: { id: 'ds-d3' },
      data: { driverSettlementId: null },
    });

    const claim = (settlementId: string) =>
      prisma.delivery.updateMany({
        where: { id: { in: ['ds-d3'] }, driverSettlementId: null },
        data: { driverSettlementId: settlementId },
      });

    const [a, b] = await Promise.all([claim(decoyA.id), claim(decoyB.id)]);

    expect([a.count, b.count].filter((n) => n === 1)).toHaveLength(1);
    expect([a.count, b.count].filter((n) => n === 0)).toHaveLength(1);

    // Nettoyage. ⚠️ L'ordre compte : supprimer les règlements d'appoint
    // d'abord remettrait `driverSettlementId` à NULL (`onDelete: SetNull`) et
    // rendrait la course de nouveau réglable — ce qui fausserait les cas
    // suivants. On la rattache donc à son règlement d'origine AVANT.
    await prisma.delivery.update({
      where: { id: 'ds-d3' },
      data: { driverSettlementId: original.driverSettlementId },
    });
    await prisma.driverSettlement.deleteMany({
      where: { id: { in: [decoyA.id, decoyB.id] } },
    });
  });

  it('7. plus rien à régler → refus explicite, aucune pièce à 0 XAF', async () => {
    await expect(
      settlements.record({
        driverId: DRIVER,
        coveredUntil: LATE,
        method: 'CASH',
        adminId: 'admin-1',
      }),
    ).rejects.toThrow();
  });

  it('8. annuler libère les courses et rend la dette à nouveau réglable', async () => {
    const s = await prisma.driverSettlement.findFirstOrThrow({
      where: { driverId: DRIVER, status: 'PAID', courseCount: 2 },
    });

    await settlements.cancel(s.id, 'admin-2', 'Montant erroné');

    const out = await settlements.getOutstanding(DRIVER, LATE);
    // Sans la libération, corriger une faute de frappe rendrait ces 1 000 XAF
    // définitivement impayables.
    expect(out.amountXaf).toBe(1000);
    expect(out.courseCount).toBe(2);

    const cancelled = await prisma.driverSettlement.findUniqueOrThrow({
      where: { id: s.id },
    });
    expect(cancelled.status).toBe('CANCELLED');
    // Le montant reste figé sur la pièce annulée : c'est une trace, pas un
    // brouillon. `courseCount` dit ce qui avait été arrêté.
    expect(cancelled.amountXaf).toBe(1000);
    expect(cancelled.courseCount).toBe(2);
  });
});
