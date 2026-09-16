import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Statuts dans lesquels une commande représente de l'argent réellement encaissé.
 *
 * ⚠️ **Cette liste ne se recopie pas, elle s'importe.** Le total, le total du
 * jour et le graphe hebdomadaire somment tous les trois `Order.total` ; le
 * graphe, lui, n'avait **aucun filtre de statut**. Une même réponse HTTP
 * annonçait donc deux chiffres d'affaires : celui du haut excluait les paniers
 * abandonnés et les annulations, celui du graphe les comptait. Sommer les sept
 * barres ne redonnait pas le total affiché au-dessus.
 *
 * `EN_ATTENTE` n'a jamais donné d'argent — `OrderExpiryService` ferme ces
 * commandes au bout de 45 minutes. `ANNULER` l'a rendu. **Tous les autres
 * statuts de l'enum y sont**, et c'est la règle que
 * `admin-dashboard-revenue-consistency.spec.ts` rend exigible.
 *
 * ⚠️ `EN_ROUTE` manquait — omission, pas décision. La liste énumérait le
 * chemin nominal complet (`PAYER → EN_PREPARATION → PRET → … → LIVRER`) en
 * sautant l'étape du milieu : une commande payée **disparaissait du chiffre
 * d'affaires pendant toute la course**, puis y revenait à la livraison. Aucune
 * lecture métier ne rend l'argent « non encaissé » le temps que le livreur
 * roule. Le défaut est antérieur à la centralisation de cette liste (il vivait
 * dans les deux copies inline) et la production en portait un cas au moment du
 * constat, le 16/09/2026.
 */
export const PAID_ORDER_STATUSES = [
  'PAYER',
  'EN_PREPARATION',
  'PRET',
  'EN_ROUTE',
  'LIVRER',
] as const;

/**
 * KPI du dashboard admin (LIL-134) : utilisateurs par rôle, CA total/jour,
 * commandes par statut + 7 jours, restaurants actifs/inactifs. Extrait de
 * `AdminService` (agrégations Prisma uniquement). `AdminService` y délègue.
 */
@Injectable()
export class AdminDashboardService {
  constructor(private prisma: PrismaService) {}

  async getDashboardStats() {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    sevenDaysAgo.setHours(0, 0, 0, 0);

    const [
      usersByRole,
      totalRevenue,
      todayRevenue,
      ordersByStatus,
      restaurantStats,
      weeklyOrders,
      pendingOrders,
    ] = await Promise.all([
      // Utilisateurs par rôle
      this.prisma.user.groupBy({
        by: ['role'],
        _count: { role: true },
      }),

      // CA total — commandes payées uniquement
      this.prisma.order.aggregate({
        where: {
          status: { in: [...PAID_ORDER_STATUSES] },
        },
        _sum: { total: true },
      }),

      // CA du jour
      this.prisma.order.aggregate({
        where: {
          status: { in: [...PAID_ORDER_STATUSES] },
          createdAt: { gte: today },
        },
        _sum: { total: true },
      }),

      // Commandes par statut
      this.prisma.order.groupBy({
        by: ['status'],
        _count: { status: true },
      }),

      // Restaurants actifs vs inactifs
      this.prisma.restaurant.groupBy({
        by: ['isActive'],
        _count: { isActive: true },
      }),

      // Commandes des 7 derniers jours pour le graphe.
      //
      // Même périmètre que les deux agrégats ci-dessus : il somme la même
      // colonne, il doit compter les mêmes lignes.
      //
      // ⚠️ Défaut connu, **non traité ici** : `by: ['createdAt']` groupe sur un
      // horodatage à la milliseconde, donc rend une ligne par commande et non
      // une par jour. Le corriger suppose un `date_trunc` en SQL brut — et
      // surtout de décider à quoi sert cet endpoint, qui n'a aujourd'hui aucun
      // appelant dans les quatre applications. Voir
      // `PHASE1D_2026-09-16_INFRA_OPS_DISCOVERY.md` §11.4.
      this.prisma.order.groupBy({
        by: ['createdAt'],
        where: {
          status: { in: [...PAID_ORDER_STATUSES] },
          createdAt: { gte: sevenDaysAgo },
        },
        _count: { id: true },
        _sum: { total: true },
      }),

      // Commandes en attente — à surveiller
      this.prisma.order.count({ where: { status: 'EN_ATTENTE' } }),
    ]);

    return {
      users: {
        byRole: Object.fromEntries(
          usersByRole.map((u) => [u.role, u._count.role]),
        ),
        total: usersByRole.reduce((sum, u) => sum + u._count.role, 0),
      },
      revenue: {
        total: totalRevenue._sum.total ?? 0,
        today: todayRevenue._sum.total ?? 0,
      },
      orders: {
        byStatus: Object.fromEntries(
          ordersByStatus.map((o) => [o.status, o._count.status]),
        ),
        pendingCount: pendingOrders,
        weekly: weeklyOrders,
      },
      restaurants: {
        active: restaurantStats.find((r) => r.isActive)?._count.isActive ?? 0,
        inactive:
          restaurantStats.find((r) => !r.isActive)?._count.isActive ?? 0,
      },
    };
  }
}
