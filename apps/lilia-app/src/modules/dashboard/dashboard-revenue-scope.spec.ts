import { DashboardSalesStatsService } from './dashboard-sales-stats.service';
import { REVENUE_ORDER_WHERE } from './revenue-scope';
import type { DashboardCommonService } from './dashboard-common.service';
import type { PrismaService } from '../../prisma/prisma.service';

/**
 * **Un tableau de bord ne peut pas annoncer deux chiffres d'affaires.**
 *
 * Quatre endpoints du dashboard vendeur somment la même colonne — `Order.total`
 * — et ne filtraient pas les mêmes lignes :
 *
 * | Endpoint | `where.status` | Ce qui entrait |
 * |---|---|---|
 * | `GET /dashboard/overview` | `≠ ANNULER` | commandes non annulées |
 * | `GET /dashboard/revenue-chart` | `≠ ANNULER` | idem |
 * | `GET /dashboard/peak-hours` | `≠ ANNULER` | idem |
 * | `GET /dashboard/orders` → `totals` | **aucun** | **+ les annulées** |
 *
 * C'est le défaut déjà corrigé côté admin
 * (`admin-dashboard-revenue-consistency.spec.ts`), présent une seconde fois de
 * l'autre côté de la plateforme. Il a survécu parce que chaque méthode, lue
 * seule, est parfaitement correcte : le défaut n'existe qu'**entre** elles.
 *
 * ## Pourquoi ce test compare les appels entre eux
 *
 * Écrire la liste attendue dans chaque assertion recréerait le problème :
 * quatre copies qui peuvent diverger, et un test qui suit la dérive au lieu de
 * la signaler. Même idiome que `pagination-bounds.spec.ts`, qui compare les
 * DTOs entre eux plutôt qu'à une liste de champs.
 *
 * ## Le contenu du périmètre : décision D-5 (23/10/2026)
 *
 * Le filtre `≠ ANNULER` comptait les `EN_ATTENTE`, des commandes jamais
 * payées. La décision est prise : « revenus » = commandes **payées et
 * livrées**, à la date de livraison (`revenue-scope.ts`). Ce test l'exige
 * partout d'un coup, comme prévu. Les heures de pointe, qui comptent
 * l'activité et non l'argent, gardent `≠ ANNULER`.
 */
describe('Dashboard vendeur — un seul périmètre de chiffre d’affaires', () => {
  /** `where` capturés par requête Prisma, dans l'ordre des appels. */
  function build() {
    const groupBy = jest.fn().mockResolvedValue([]);
    const findMany = jest.fn().mockResolvedValue([]);
    const aggregate = jest
      .fn()
      .mockResolvedValue({ _sum: { total: 0 }, _count: { id: 0 } });
    const count = jest.fn().mockResolvedValue(0);

    const prisma = {
      order: { groupBy, findMany, aggregate, count },
      product: { count: jest.fn().mockResolvedValue(0) },
      review: {
        aggregate: jest
          .fn()
          .mockResolvedValue({ _avg: { rating: 0 }, _count: { rating: 0 } }),
      },
      restaurant: { findMany: jest.fn().mockResolvedValue([]) },
    } as unknown as PrismaService;

    const common = {
      getRestaurant: jest.fn().mockResolvedValue({ id: 'r1' }),
      getDateFilter: jest.fn().mockReturnValue(undefined),
    } as unknown as DashboardCommonService;

    return {
      service: new DashboardSalesStatsService(prisma, common),
      groupBy,
      findMany,
      aggregate,
    };
  }

  interface PrismaArgs {
    where?: { status?: unknown; paidAt?: unknown };
    select?: Record<string, unknown>;
    _sum?: Record<string, unknown>;
  }

  /**
   * Une requête « d'argent » lit ou somme `Order.total`.
   *
   * ⚠️ Le filtre compte, et il est la moitié de ce test. `getOverview` appelle
   * aussi `order.findMany` **trois fois** pour dénombrer des clients distincts
   * (`select: { userId }`) : ces requêtes-là n'ont aucune raison de filtrer par
   * statut, et les inclure ferait échouer ce test sur un comportement correct.
   * Ce qu'on exige, c'est que les requêtes qui touchent au **montant** aient
   * toutes le même périmètre — pas que toutes les requêtes se ressemblent.
   */
  const touchesMoney = (args: PrismaArgs) =>
    args?.select?.total !== undefined || args?._sum?.total !== undefined;

  it('D-5 : toute requête qui somme Order.total porte le périmètre payées et livrées', async () => {
    const { service, findMany, aggregate, groupBy } = build();

    // `getOrderStats` est volontairement absent : son `groupBy` doit ramener la
    // ligne `ANNULER` pour `byStatus`, donc il ne peut pas la filtrer en SQL.
    // Son total est vérifié par le test suivant.
    await service.getOverview('uid');
    await service.getRevenueChart('uid');
    await service.getPeakHours('uid');
    await service.getRestaurantRanking();

    const moneyCalls = [
      ...aggregate.mock.calls,
      ...findMany.mock.calls,
      ...groupBy.mock.calls,
    ]
      .map((call) => call[0] as PrismaArgs)
      .filter(touchesMoney);

    // Garde-fou du garde-fou : si un jour plus aucune requête n'est reconnue,
    // ce test passerait à vide en donnant l'illusion de protéger.
    // 4 sommes de la vue générale + graphique + classement.
    expect(moneyCalls.length).toBeGreaterThanOrEqual(6);

    for (const args of moneyCalls) {
      expect({
        status: args.where?.status,
        paidAt: args.where?.paidAt,
      }).toEqual(REVENUE_ORDER_WHERE);
    }
  });

  it('le total de GET /dashboard/orders suit D-5, le nombre de commandes reste l’activité', async () => {
    const { service, groupBy, aggregate } = build();

    groupBy.mockResolvedValueOnce([
      { status: 'LIVRER', _count: { status: 3 }, _sum: { total: 3_000 } },
      { status: 'EN_ATTENTE', _count: { status: 2 }, _sum: { total: 9_000 } },
      { status: 'ANNULER', _count: { status: 7 }, _sum: { total: 70_000 } },
    ]);
    aggregate.mockResolvedValueOnce({
      _sum: { total: 3_000 },
      _count: { id: 3 },
    });

    const { data } = await service.getOrderStats('uid');

    // Ni les annulations ni les commandes jamais payées ne sont un revenu.
    expect(data.totals.revenue).toBe(3_000);
    // Activité : commandes non annulées.
    expect(data.totals.orders).toBe(5);
    // Panier moyen sur les commandes comptées en revenus, pas sur l'activité.
    expect(data.totals.averageOrderValue).toBe('1000');

    const revenueCall = aggregate.mock.calls[0][0] as PrismaArgs;
    expect({
      status: revenueCall.where?.status,
      paidAt: revenueCall.where?.paidAt,
    }).toEqual(REVENUE_ORDER_WHERE);
  });

  it('les heures de pointe restent l’activité : commandes non annulées', async () => {
    const { service, findMany } = build();
    await service.getPeakHours('uid');
    const args = findMany.mock.calls[0][0] as PrismaArgs;
    expect(args.where?.status).toEqual({ not: 'ANNULER' });
  });

  it('les parts par statut somment à 100 % — annulations comprises', async () => {
    const { service, groupBy } = build();

    groupBy.mockResolvedValueOnce([
      { status: 'LIVRER', _count: { status: 3 }, _sum: { total: 3_000 } },
      { status: 'ANNULER', _count: { status: 7 }, _sum: { total: 70_000 } },
    ]);

    const { data } = await service.getOrderStats('uid');

    // ⚠️ Le piège : diviser par le total *facturable* ferait afficher
    // « ANNULER 233,3 % ». `byStatus` répartit TOUTES les commandes.
    const parts = data.byStatus.map((s) => Number(s.percentage));

    expect(parts).toEqual([30, 70]);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(100);
  });

  it('byStatus continue d’exposer la ligne ANNULER', async () => {
    const { service, groupBy } = build();

    groupBy.mockResolvedValueOnce([
      { status: 'ANNULER', _count: { status: 7 }, _sum: { total: 70_000 } },
    ]);

    const { data } = await service.getOrderStats('uid');

    // Un vendeur doit voir ce qu'il perd : c'est l'objet même de cet endpoint.
    expect(data.byStatus).toHaveLength(1);
    expect(data.byStatus[0]).toMatchObject({
      status: 'ANNULER',
      count: 7,
      revenue: 70_000,
    });
  });
});
