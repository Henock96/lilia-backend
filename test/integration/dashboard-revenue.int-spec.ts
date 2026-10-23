import { PrismaPg } from '@prisma/adapter-pg';
import { OrderStatus, PrismaClient } from '@prisma/client';

import { DashboardCommonService } from '../../apps/lilia-app/src/modules/dashboard/dashboard-common.service';
import { DashboardSalesStatsService } from '../../apps/lilia-app/src/modules/dashboard/dashboard-sales-stats.service';

/**
 * **Lot 5 (ADM-13, décision D-5) — « revenus » = commandes payées et livrées.**
 *
 * Sur un vrai PostgreSQL : une commande en attente de paiement, un échec de
 * livraison, une commande livrée sans paiement et une commande annulée ne
 * comptent dans aucun des quatre chiffres « revenus » du tableau de bord ;
 * seule la commande payée et livrée y entre, à la date de sa livraison.
 */
const DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

describeIfDb('Lot 5 — revenus payés et livrés (PostgreSQL réel)', () => {
  let prisma: PrismaClient;
  let sales: DashboardSalesStatsService;

  const now = new Date();
  const hourAgo = new Date(now.getTime() - 60 * 60 * 1000);

  beforeAll(async () => {
    prisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: DATABASE_URL }),
    });
    await prisma.$connect();
    const common = new DashboardCommonService(prisma as never);
    sales = new DashboardSalesStatsService(prisma as never, common);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(`
      TRUNCATE TABLE "OrderItem", "OrderHistory", "Order", "Restaurant", "User"
      RESTART IDENTITY CASCADE
    `);
    await prisma.user.createMany({
      data: [
        {
          id: 'own',
          firebaseUid: 'fb-own',
          email: 'own@test.local',
          role: 'RESTAURATEUR',
        },
        {
          id: 'adm',
          firebaseUid: 'fb-adm',
          email: 'adm@test.local',
          role: 'ADMIN',
        },
        { id: 'cli', firebaseUid: 'fb-cli', email: 'cli@test.local' },
      ],
    });
    await prisma.restaurant.create({
      data: {
        id: 'resto',
        nom: 'Chez Lili',
        adresse: 'Poto-Poto',
        phone: '060000001',
        ownerId: 'own',
      },
    });

    const order = (
      id: string,
      status: OrderStatus,
      total: number,
      extra: {
        paidAt?: Date;
        deliveredAt?: Date;
        failureLiability?: 'CLIENT';
      } = {},
    ) => ({
      id,
      restaurantId: 'resto',
      userId: 'cli',
      subTotal: total,
      deliveryFee: 0,
      deliveryFeeGross: 0,
      total,
      paymentMethod: 'MTN_MOMO' as const,
      isDelivery: false,
      status,
      createdAt: hourAgo,
      ...extra,
    });

    await prisma.order.createMany({
      data: [
        // Seule commande qui compte : payée et livrée aujourd'hui.
        order('paid-delivered', OrderStatus.LIVRER, 5000, {
          paidAt: hourAgo,
          deliveredAt: now,
        }),
        // Jamais payée.
        order('pending', OrderStatus.EN_ATTENTE, 1000),
        // Payée, mais la livraison n'a pas abouti.
        // (`Order_failure_liability_chk` : un échec désigne un responsable.)
        order('failed', OrderStatus.ECHEC_LIVRAISON, 2000, {
          paidAt: hourAgo,
          failureLiability: 'CLIENT',
        }),
        // Livrée, mais aucun paiement enregistré.
        order('delivered-unpaid', OrderStatus.LIVRER, 4000, {
          deliveredAt: now,
        }),
        // Annulée.
        order('cancelled', OrderStatus.ANNULER, 8000, { paidAt: hourAgo }),
        // Payée et livrée il y a 40 jours : hors du jour, du graphique 30 j.
        order('old', OrderStatus.LIVRER, 3000, {
          paidAt: new Date(now.getTime() - 40 * 86_400_000),
          deliveredAt: new Date(now.getTime() - 40 * 86_400_000),
        }),
      ],
    });
  });

  it('vue générale : revenus du jour = la seule commande payée et livrée', async () => {
    const { data } = await sales.getOverview('fb-own');

    expect(data.revenue.today).toBe(5000);
    // Tout l'historique : + la commande payée et livrée il y a 40 jours.
    expect(data.revenue.total).toBe(8000);
    // L'activité, elle, compte toujours les commandes non annulées.
    expect(data.orders.total).toBe(5);
  });

  it('statistiques par statut : total et panier moyen sur le même périmètre', async () => {
    const { data } = await sales.getOrderStats('fb-own');

    expect(data.totals.revenue).toBe(8000);
    expect(data.totals.averageOrderValue).toBe('4000');
    // `byStatus` montre encore tout, annulations comprises.
    expect(data.byStatus.map((s) => s.status)).toContain('ANNULER');
  });

  it('graphique : 5 000 FCFA le jour de livraison, rien d’autre sur 30 jours', async () => {
    const { data } = await sales.getRevenueChart('fb-own', 30);

    expect(data.reduce((acc, d) => acc + d.revenue, 0)).toBe(5000);
    expect(data.reduce((acc, d) => acc + d.orders, 0)).toBe(1);
  });

  it('classement des vendeurs (ADMIN) : même périmètre', async () => {
    const { data } = await sales.getRestaurantRanking();

    expect(data).toHaveLength(1);
    expect(data[0]).toMatchObject({
      id: 'resto',
      totalRevenue: 8000,
      orderCount: 2,
    });
  });
});
