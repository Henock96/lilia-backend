import { OrderStatus } from '@prisma/client';

import {
  AdminDashboardService,
  PAID_ORDER_STATUSES,
} from './admin-dashboard.service';
import type { PrismaService } from '../../prisma/prisma.service';

/**
 * **Une seule réponse HTTP ne peut pas compter deux choses différentes.**
 *
 * `GET /admin/dashboard` rend, dans le même objet, un `revenue.total` et un
 * graphe `orders.weekly` porteur d'un `_sum.total`. Les deux additionnent la
 * même colonne — `Order.total` — mais ne filtraient pas les mêmes lignes :
 *
 * | | `where.status` | Ce qui entrait |
 * |---|---|---|
 * | `revenue.total` / `revenue.today` | `PAYER, EN_PREPARATION, PRET, LIVRER` | commandes payées |
 * | `orders.weekly` | **aucun filtre** | + les `EN_ATTENTE` jamais payées **et** les `ANNULER` |
 *
 * Un lecteur qui sommait les sept barres du graphe n'obtenait donc pas le
 * total affiché juste au-dessus, et l'écart n'était pas un arrondi : il valait
 * tous les paniers abandonnés de la semaine — ceux-là mêmes qu'`OrderExpiryService`
 * ferme au bout de 45 minutes.
 *
 * ## Pourquoi ce test compare les filtres entre eux
 *
 * Écrire trois fois la liste attendue des statuts créerait exactement le défaut
 * qu'on corrige : trois copies qui peuvent diverger, et un test qui suit la
 * dérive au lieu de la signaler. Le test interroge donc les appels **les uns
 * par rapport aux autres** — même idiome que `pagination-bounds.spec.ts`, qui
 * compare les DTOs entre eux plutôt qu'à une liste de champs.
 *
 * ⚠️ Constat annexe, **non corrigé** : `by: ['createdAt']` groupe sur un
 * horodatage à la milliseconde, donc rend une ligne par commande et non une par
 * jour. Et `GET /admin/dashboard` n'a **aucun appelant** dans les quatre
 * applications (vérifié le 16/09/2026). Les deux sont documentés dans
 * `PHASE1D_2026-09-16_INFRA_OPS_DISCOVERY.md` §11.4 ; les traiter suppose de
 * décider à quoi sert cet endpoint, ce qui n'est pas une correction de bug.
 */
describe('GET /admin/dashboard — un seul périmètre de chiffre d’affaires', () => {
  function build() {
    const aggregate = jest.fn().mockResolvedValue({ _sum: { total: 0 } });
    const groupBy = jest.fn().mockResolvedValue([]);
    const count = jest.fn().mockResolvedValue(0);

    const prisma = {
      user: { groupBy: jest.fn().mockResolvedValue([]) },
      restaurant: { groupBy: jest.fn().mockResolvedValue([]) },
      order: { aggregate, groupBy, count },
    } as unknown as PrismaService;

    return {
      service: new AdminDashboardService(prisma),
      aggregate,
      groupBy,
    };
  }

  /** `where.status.in` d'un appel Prisma, ou `undefined` s'il n'en porte pas. */
  const statusFilter = (call: [{ where?: { status?: { in?: string[] } } }]) =>
    call[0]?.where?.status?.in;

  it('applique le même filtre de statut au total, au jour et au graphe', async () => {
    const { service, aggregate, groupBy } = build();

    await service.getDashboardStats();

    const [totalCall, todayCall] = aggregate.mock.calls;
    // `groupBy` est appelé deux fois : d'abord `ordersByStatus` (qui regroupe
    // par statut, donc ne peut pas en filtrer un), puis le graphe hebdomadaire.
    const weeklyCall = groupBy.mock.calls[1];

    const reference = statusFilter(totalCall as never);

    expect(reference).toBeDefined();
    expect(statusFilter(todayCall as never)).toEqual(reference);
    expect(statusFilter(weeklyCall as never)).toEqual(reference);
  });

  it('exclut les commandes jamais payées et les commandes annulées', async () => {
    const { service, aggregate } = build();

    await service.getDashboardStats();

    const statuses = statusFilter(aggregate.mock.calls[0] as never)!;

    // Les deux seuls statuts dont l'inclusion serait un mensonge comptable :
    // l'un n'a jamais donné d'argent, l'autre l'a rendu.
    expect(statuses).not.toContain('EN_ATTENTE');
    expect(statuses).not.toContain('ANNULER');
  });

  /**
   * ⚠️ **Le test précédent ne suffit pas, et c'est ce qui a laissé passer le
   * défaut.**
   *
   * « Ne contient pas `EN_ATTENTE` ni `ANNULER` » est satisfait par une liste
   * vide, et par toute liste **trouée**. `EN_ROUTE` manquait depuis l'origine :
   * une commande payée sortait du chiffre d'affaires pendant toute la course,
   * puis y rentrait à la livraison — et les trois agrégats étant alimentés par
   * la même constante, le test de cohérence les trouvait parfaitement d'accord
   * entre eux. **Trois copies du même chiffre faux sont cohérentes.**
   *
   * La règle est donc écrite dans l'autre sens : on part de l'enum `OrderStatus`
   * — la seule liste que personne ne peut oublier de mettre à jour, puisque
   * Prisma la génère — et on exige que **tout** statut y figure, sauf les deux
   * exclusions nommées. Ajouter une valeur à l'enum fait échouer ce test tant
   * que quelqu'un n'a pas tranché de quel côté elle tombe.
   */
  it('couvre tous les statuts de l’enum sauf les deux exclus', () => {
    const NEVER_PAID = [OrderStatus.EN_ATTENTE, OrderStatus.ANNULER] as const;

    const attendu = Object.values(OrderStatus).filter(
      (status) => !NEVER_PAID.includes(status as (typeof NEVER_PAID)[number]),
    );

    expect([...PAID_ORDER_STATUSES].sort()).toEqual([...attendu].sort());
  });

  it('borne le graphe hebdomadaire à sept jours', async () => {
    const { service, groupBy } = build();

    const before = Date.now();
    await service.getDashboardStats();

    const weeklyCall = groupBy.mock.calls[1][0] as {
      where: { createdAt: { gte: Date } };
    };
    const ageInDays =
      (before - weeklyCall.where.createdAt.gte.getTime()) / 86_400_000;

    // Entre 7 et 8 : la borne est ramenée à minuit, ce qui ajoute au plus un
    // jour partiel.
    expect(ageInDays).toBeGreaterThanOrEqual(7);
    expect(ageInDays).toBeLessThan(8);
  });
});
