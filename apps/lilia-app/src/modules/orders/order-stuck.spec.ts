import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { OrderStatus } from '@prisma/client';

import { OrderQueryService } from './order-query.service';
import { PrismaService } from '../../prisma/prisma.service';
import { PaginationService } from '../../common/pagination/pagination.service';

/**
 * Commandes bloquées — la source de l'alerte du tableau de bord.
 *
 * L'alerte existait déjà côté Web, mais elle filtrait **les vingt commandes
 * reçues** : une commande bloquée depuis trois heures en sortait dès que vingt
 * plus récentes arrivaient. L'alerte s'éteignait précisément quand le problème
 * s'aggravait (audit du 09/09/2026, D-4).
 *
 * Elle mesurait aussi la mauvaise chose : `EN_ATTENTE` y figurait, c'est-à-dire
 * les paniers abandonnés que le cron d'expiration ferme tout seul au bout de
 * 45 minutes. Ils noyaient les cas réels.
 */
describe('OrderQueryService.countStuckOrders', () => {
  let service: OrderQueryService;

  const prisma = {
    user: { findUnique: jest.fn() },
    order: { findMany: jest.fn(), count: jest.fn(), groupBy: jest.fn() },
    restaurant: { findFirst: jest.fn() },
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    prisma.order.groupBy.mockResolvedValue([]);
    prisma.order.findMany.mockResolvedValue([]);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OrderQueryService,
        { provide: PrismaService, useValue: prisma },
        PaginationService,
      ],
    }).compile();

    service = module.get(OrderQueryService);
  });

  function asAdmin() {
    prisma.user.findUnique.mockResolvedValue({ id: 'u-9', role: 'ADMIN' });
  }

  function asVendor() {
    prisma.user.findUnique.mockResolvedValue({
      id: 'u-1',
      role: 'RESTAURATEUR',
    });
    prisma.restaurant.findFirst.mockResolvedValue({ id: 'r-1' });
  }

  /** Le `where` passé au `groupBy` — c'est lui qui définit « bloquée ». */
  function groupByWhere(): Record<string, unknown> {
    return prisma.order.groupBy.mock.calls[0][0].where as Record<
      string,
      unknown
    >;
  }

  it('ne retient que les états où l’argent est encaissé et rien n’est livré', async () => {
    // `EN_ATTENTE` est exclu : la commande n'est pas payée et le cron
    // d'expiration la ferme seul. `EN_ROUTE` aussi : quelqu'un la porte, le
    // retard s'y traite dans le flux de livraison.
    asAdmin();

    await service.countStuckOrders('fb-9', 30);

    expect(groupByWhere().status).toEqual({
      in: [OrderStatus.PAYER, OrderStatus.EN_PREPARATION, OrderStatus.PRET],
    });
  });

  it('applique le seuil demandé sur la date de création', async () => {
    asAdmin();
    const before = Date.now();

    await service.countStuckOrders('fb-9', 45);

    const createdAt = groupByWhere().createdAt as { lte: Date };
    const expected = before - 45 * 60_000;
    // Tolérance : le service capture `now` juste après nous.
    expect(createdAt.lte.getTime()).toBeGreaterThanOrEqual(expected - 5_000);
    expect(createdAt.lte.getTime()).toBeLessThanOrEqual(expected + 5_000);
  });

  it('ne compte pas une précommande dont l’heure n’est pas venue', async () => {
    // Piège : une précommande passée pour dans trois jours a un `createdAt`
    // ancien **par construction**. Sans cette garde, l'alerte annoncerait
    // « bloquée depuis 4320 minutes » sur une commande parfaitement normale,
    // et l'opérateur apprendrait à ignorer l'alerte.
    asAdmin();

    await service.countStuckOrders('fb-9', 30);

    expect(groupByWhere().OR).toEqual([
      { isPreorder: false },
      { isPreorder: true, scheduledFor: { lte: expect.any(Date) as unknown } },
    ]);
  });

  it('borne un vendeur à sa propre boutique', async () => {
    asVendor();

    await service.countStuckOrders('fb-1', 30);

    expect(groupByWhere()).toMatchObject({ restaurantId: 'r-1' });
  });

  it('borne l’admin aux commandes non effacées', async () => {
    asAdmin();

    await service.countStuckOrders('fb-9', 30);

    expect(groupByWhere()).toMatchObject({ deleteCommande: false });
  });

  it('rend le détail par statut et le total', async () => {
    asAdmin();
    prisma.order.groupBy.mockResolvedValue([
      { status: OrderStatus.PAYER, _count: { status: 3 } },
      { status: OrderStatus.PRET, _count: { status: 1 } },
    ]);

    const res = await service.countStuckOrders('fb-9', 30);

    expect(res.data.total).toBe(4);
    expect(res.data.byStatus).toEqual({
      PAYER: 3,
      EN_PREPARATION: 0,
      PRET: 1,
    });
    expect(res.data.thresholdMinutes).toBe(30);
  });

  it('dit depuis combien de temps attend la plus ancienne', async () => {
    // « 4 commandes en retard » n'appelle pas la même réaction que « la plus
    // ancienne attend depuis 3 heures ».
    asAdmin();
    prisma.order.groupBy.mockResolvedValue([
      { status: OrderStatus.PRET, _count: { status: 1 } },
    ]);
    prisma.order.findMany.mockResolvedValue([
      { createdAt: new Date(Date.now() - 187 * 60_000) },
    ]);

    const res = await service.countStuckOrders('fb-9', 30);

    expect(res.data.oldestMinutes).toBeGreaterThanOrEqual(186);
    expect(res.data.oldestMinutes).toBeLessThanOrEqual(188);
  });

  it('rend null plutôt que zéro quand rien n’est bloqué', async () => {
    // Zéro se lirait comme « une commande vient de se bloquer ».
    asAdmin();

    const res = await service.countStuckOrders('fb-9', 30);

    expect(res.data.total).toBe(0);
    expect(res.data.oldestMinutes).toBeNull();
  });

  it('refuse un seuil hors bornes', async () => {
    asAdmin();

    await expect(service.countStuckOrders('fb-9', 0)).rejects.toThrow(
      BadRequestException,
    );
    await expect(service.countStuckOrders('fb-9', 2000)).rejects.toThrow(
      BadRequestException,
    );
    expect(prisma.order.groupBy).not.toHaveBeenCalled();
  });
});
