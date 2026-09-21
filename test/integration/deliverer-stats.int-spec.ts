import { PrismaPg } from '@prisma/adapter-pg';
import { DeliveryStatus, PrismaClient } from '@prisma/client';

import { AdminDeliverersService } from '../../apps/lilia-app/src/modules/admin/admin-deliverers.service';

/**
 * **Statistiques d'un livreur, contre un vrai PostgreSQL.**
 *
 * ## Pourquoi ce test est une intégration et pas un unitaire
 *
 * Il couvre une **réécriture de requête** : `getDelivererStats` chargeait
 * *toutes* les courses livrées du livreur depuis toujours
 * (`delivery.findMany` sans `take`), avec une jointure sur `Order`, pour en
 * dériver quatre agrégats en mémoire. Le temps de réponse croissait donc sans
 * borne avec l'historique — à vingt courses par jour, la fiche d'un livreur
 * charge sept mille lignes au bout d'un an.
 *
 * Remplacer cela par des agrégats SQL ne se prouve pas avec un `$queryRaw`
 * mocké : un mock rend ce qu'on lui dit de rendre, donc il valide la forme de
 * l'appel, jamais le résultat de la requête. Les quatre nombres doivent être
 * vérifiés contre la base qui les calcule.
 *
 * ## Ce qu'il fige, au-delà de la performance
 *
 * Les cas limites de l'économie de course, qui sont ceux où le système refuse
 * de mentir :
 *  · une course **sans** économie gelée n'entre pas dans `driverPayXaf` et est
 *    comptée dans `coursesWithoutEconomics` ;
 *  · zéro course gelée ⇒ `driverPayXaf = null`, **jamais `0`** — « on ne sait
 *    pas » n'est pas « il n'a rien gagné » ;
 *  · une course sans `pickedUpAt` n'entre pas dans la durée moyenne.
 *
 * Se saute proprement sans `TEST_DATABASE_URL`.
 */
const DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

describeIfDb('Statistiques livreur — agrégats SQL', () => {
  let prisma: PrismaClient;
  let service: AdminDeliverersService;

  const DRIVER = 'ds-stats-driver';
  const OTHER_DRIVER = 'ds-stats-other';
  const CLIENT = 'ds-stats-client';
  const OWNER = 'ds-stats-owner';
  const VENDOR = 'ds-stats-vendor';

  /** Crée une commande + sa livraison, avec ou sans économie gelée. */
  const seedDelivery = async (opts: {
    id: string;
    delivererId: string;
    status: DeliveryStatus;
    orderTotal: number;
    driverPayXaf?: number | null;
    frozen?: boolean;
    pickedUpAt?: Date | null;
    deliveredAt?: Date | null;
  }) => {
    await prisma.order.create({
      data: {
        id: `o-${opts.id}`,
        restaurantId: VENDOR,
        userId: CLIENT,
        subTotal: opts.orderTotal,
        deliveryFee: 0,
        serviceFee: 0,
        total: opts.orderTotal,
        paymentMethod: 'MTN_MOMO',
        status: 'LIVRER',
      },
    });
    await prisma.delivery.create({
      data: {
        id: opts.id,
        orderId: `o-${opts.id}`,
        delivererId: opts.delivererId,
        status: opts.status,
        pickedUpAt: opts.pickedUpAt ?? null,
        deliveredAt: opts.deliveredAt ?? null,
        driverPayXaf: opts.driverPayXaf ?? null,
        driverEconomicsFrozenAt: opts.frozen ? new Date() : null,
      },
    });
  };

  beforeAll(async () => {
    prisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: DATABASE_URL }),
    });
    await prisma.$connect();
    service = new AdminDeliverersService(prisma as never);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(`
      TRUNCATE TABLE "PaymentEvent", "restaurant_payouts", "OutboxEvent",
                     "Incident", "DeliveryReview", "DeliveryLocation",
                     "DeliveryAssignment", "Delivery", "LoyaltyTransaction",
                     "OrderItem", "OrderHistory", "payments", "Refund",
                     "Order", "CartItem", "Cart", "ProductVariant", "Product",
                     "Restaurant", "User"
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
        {
          id: OTHER_DRIVER,
          firebaseUid: 'fb-ds-d2',
          email: 'ds-d2@test.local',
          role: 'LIVREUR',
        },
      ],
    });
    await prisma.restaurant.create({
      data: {
        id: VENDOR,
        nom: 'Chez Stats',
        adresse: 'Poto-Poto',
        phone: '060000000',
        ownerId: OWNER,
      },
    });
  });

  it('agrège les courses livrées sans charger les lignes', async () => {
    const t0 = new Date('2026-09-20T10:00:00Z');
    const t30 = new Date('2026-09-20T10:30:00Z');
    const t50 = new Date('2026-09-20T10:50:00Z');

    await seedDelivery({
      id: 'd1',
      delivererId: DRIVER,
      status: DeliveryStatus.LIVRER,
      orderTotal: 5000,
      driverPayXaf: 350,
      frozen: true,
      pickedUpAt: t0,
      deliveredAt: t30,
    });
    await seedDelivery({
      id: 'd2',
      delivererId: DRIVER,
      status: DeliveryStatus.LIVRER,
      orderTotal: 3000,
      driverPayXaf: 200,
      frozen: true,
      pickedUpAt: t0,
      deliveredAt: t50,
    });
    // Course livrée SANS économie : compte dans la valeur portée et dans les
    // durées, mais pas dans la rémunération.
    await seedDelivery({
      id: 'd3',
      delivererId: DRIVER,
      status: DeliveryStatus.LIVRER,
      orderTotal: 2000,
      frozen: false,
      pickedUpAt: null,
      deliveredAt: t30,
    });
    await seedDelivery({
      id: 'd4',
      delivererId: DRIVER,
      status: DeliveryStatus.ECHEC,
      orderTotal: 9999,
    });
    // Course d'un AUTRE livreur : ne doit jamais entrer dans le total.
    await seedDelivery({
      id: 'd5',
      delivererId: OTHER_DRIVER,
      status: DeliveryStatus.LIVRER,
      orderTotal: 100000,
      driverPayXaf: 99999,
      frozen: true,
      pickedUpAt: t0,
      deliveredAt: t30,
    });

    const { data } = await service.getDelivererStats(DRIVER);

    expect(data.deliveredCount).toBe(3);
    expect(data.failedCount).toBe(1);
    expect(data.totalDeliveries).toBe(4);
    // 5000 + 3000 + 2000 — sans la course de l'autre livreur.
    expect(data.handledOrderValueXaf).toBe(10000);
    // 350 + 200 — la course non gelée n'y entre pas.
    expect(data.driverPayXaf).toBe(550);
    expect(data.coursesWithoutEconomics).toBe(1);
    // (30 + 50) / 2 — `d3` n'a pas de `pickedUpAt`, elle est exclue.
    expect(data.avgDeliveryMinutes).toBe(40);
    expect(data.successRate).toBe(75);
  });

  it('rend driverPayXaf = null — jamais 0 — quand aucune course n’a d’économie', async () => {
    // L'invariant le plus important du module : « on ne sait pas » ne doit
    // jamais se lire « il n'a rien gagné ».
    await seedDelivery({
      id: 'd1',
      delivererId: DRIVER,
      status: DeliveryStatus.LIVRER,
      orderTotal: 5000,
      frozen: false,
      pickedUpAt: new Date('2026-09-20T10:00:00Z'),
      deliveredAt: new Date('2026-09-20T10:20:00Z'),
    });

    const { data } = await service.getDelivererStats(DRIVER);

    expect(data.driverPayXaf).toBeNull();
    expect(data.coursesWithoutEconomics).toBe(1);
  });

  it('rend des zéros cohérents pour un livreur sans aucune course', async () => {
    const { data } = await service.getDelivererStats(DRIVER);

    expect(data.totalDeliveries).toBe(0);
    expect(data.handledOrderValueXaf).toBe(0);
    expect(data.driverPayXaf).toBeNull();
    expect(data.avgDeliveryMinutes).toBeNull();
    expect(data.successRate).toBe(0);
  });

  it("⚠️ ne charge AUCUNE ligne de livraison : le coût ne croît pas avec l'historique", async () => {
    // La propriété qui motive la réécriture. Un `findMany` sur les courses
    // livrées ferait croître la mémoire et le temps de réponse avec
    // l'ancienneté du livreur, sans borne.
    await seedDelivery({
      id: 'd1',
      delivererId: DRIVER,
      status: DeliveryStatus.LIVRER,
      orderTotal: 5000,
      driverPayXaf: 350,
      frozen: true,
      pickedUpAt: new Date('2026-09-20T10:00:00Z'),
      deliveredAt: new Date('2026-09-20T10:30:00Z'),
    });

    const spy = jest.spyOn(prisma.delivery, 'findMany');
    await service.getDelivererStats(DRIVER);

    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
