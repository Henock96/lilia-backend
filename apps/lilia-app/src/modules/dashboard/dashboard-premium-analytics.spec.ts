import { DashboardCatalogStatsService } from './dashboard-catalog-stats.service';
import { DashboardCommonService } from './dashboard-common.service';
import { DashboardSalesStatsService } from './dashboard-sales-stats.service';
import type { PrismaService } from '../../prisma/prisma.service';

/**
 * Retours produit, lot D (D3) — produits phares et heures de pointe réservés
 * au Premium. Le serveur ne livre plus ces données à un vendeur Standard :
 * `200` avec une liste vide et `premiumRequired: true` (une app vendeurs
 * installée lit une liste vide, sans carte d'erreur). L'ADMIN garde tout.
 */
describe('Dashboard — statistiques avancées réservées au Premium (lot D)', () => {
  function build(opts: { role: 'ADMIN' | 'RESTAURATEUR'; premium: boolean }) {
    const prisma = {
      user: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: 'u1', role: opts.role, firebaseUid: 'fb' }),
      },
      restaurant: { findFirst: jest.fn().mockResolvedValue({ id: 'r1' }) },
      orderItem: {
        groupBy: jest.fn().mockResolvedValue([
          {
            productId: 'p1',
            _sum: { quantite: 3, prix: 6000 },
            _count: { productId: 2 },
          },
        ]),
      },
      product: {
        findMany: jest.fn().mockResolvedValue([{ id: 'p1', nom: 'Poulet' }]),
      },
      order: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ createdAt: new Date('2026-11-16T11:00:00Z') }]),
      },
    };
    const subscriptions = {
      verdictFor: jest.fn().mockResolvedValue({
        plan: opts.premium ? 'PREMIUM' : null,
        active: opts.premium,
        currentPeriodEndsAt: null,
        paidUntil: null,
        entitlements: opts.premium
          ? ['ANALYTICS_ADVANCED', 'ON_SITE_RESERVATIONS']
          : [],
      }),
    };
    const common = new DashboardCommonService(
      prisma as unknown as PrismaService,
      subscriptions as never,
    );
    return {
      prisma,
      subscriptions,
      catalog: new DashboardCatalogStatsService(
        prisma as unknown as PrismaService,
        common,
      ),
      sales: new DashboardSalesStatsService(
        prisma as unknown as PrismaService,
        common,
      ),
    };
  }

  it('vendeur Standard : produits phares vides, aucune requête de ventes', async () => {
    const { catalog, prisma } = build({ role: 'RESTAURATEUR', premium: false });
    await expect(catalog.getTopProducts('fb')).resolves.toEqual({
      data: [],
      premiumRequired: true,
    });
    expect(prisma.orderItem.groupBy).not.toHaveBeenCalled();
  });

  it('vendeur Standard : heures de pointe vides, `peakHour` nul', async () => {
    const { sales, prisma } = build({ role: 'RESTAURATEUR', premium: false });
    await expect(sales.getPeakHours('fb')).resolves.toEqual({
      data: [],
      peakHour: null,
      premiumRequired: true,
    });
    expect(prisma.order.findMany).not.toHaveBeenCalled();
  });

  it('vendeur Premium : les données, verdict lu pour SON restaurant', async () => {
    const { catalog, sales, subscriptions } = build({
      role: 'RESTAURATEUR',
      premium: true,
    });
    const top = await catalog.getTopProducts('fb');
    expect(top.premiumRequired).toBe(false);
    expect(top.data).toHaveLength(1);
    const peak = await sales.getPeakHours('fb');
    expect(peak.premiumRequired).toBe(false);
    expect(peak.data).toHaveLength(24);
    expect(subscriptions.verdictFor).toHaveBeenCalledWith(
      'r1',
      expect.any(Date),
    );
  });

  it('ADMIN : les données, sans lire d’abonnement', async () => {
    const { catalog, sales, subscriptions } = build({
      role: 'ADMIN',
      premium: false,
    });
    expect((await catalog.getTopProducts('fb')).data).toHaveLength(1);
    expect((await sales.getPeakHours('fb')).data).toHaveLength(24);
    expect(subscriptions.verdictFor).not.toHaveBeenCalled();
  });
});
