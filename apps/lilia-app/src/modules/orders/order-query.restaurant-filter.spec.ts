import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { OrderStatus } from '@prisma/client';

import { OrderQueryService } from './order-query.service';
import { PrismaService } from '../../prisma/prisma.service';
import { PaginationService } from '../../common/pagination/pagination.service';

/**
 * `GET /orders/restaurant` sert **la même page** aux deux back-offices, et
 * l'écran Commandes du Web est partagé entre ADMIN et RESTAURATEUR.
 *
 * Le raccordement d'`/admin/orders` (blocker n°1) ne règle donc que la moitié
 * du problème : sans filtre de statut ni compteurs côté vendeur, le même écran
 * garderait deux comportements — onglets honnêtes pour l'admin, onglets
 * calculés sur la page courante pour le vendeur. Un compteur qui dépend du
 * rôle de celui qui regarde n'est pas un compteur.
 *
 * Ces tests exigent la symétrie de contrat : `{ data, meta: { total, page,
 * limit, totalPages, statusCounts } }` des deux côtés.
 */
describe('OrderQueryService.findRestaurantOrders — filtre et compteurs', () => {
  let service: OrderQueryService;

  const prisma = {
    user: { findUnique: jest.fn() },
    order: { findMany: jest.fn(), count: jest.fn(), groupBy: jest.fn() },
    restaurant: { findFirst: jest.fn() },
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    prisma.order.findMany.mockResolvedValue([]);
    prisma.order.count.mockResolvedValue(0);
    prisma.order.groupBy.mockResolvedValue([]);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OrderQueryService,
        { provide: PrismaService, useValue: prisma },
        PaginationService,
      ],
    }).compile();

    service = module.get(OrderQueryService);
  });

  /** Le vendeur d'une boutique donnée. */
  function asVendor() {
    prisma.user.findUnique.mockResolvedValue({
      id: 'u-1',
      role: 'RESTAURATEUR',
    });
    prisma.restaurant.findFirst.mockResolvedValue({ id: 'r-1' });
  }

  /** Un administrateur — pas de boutique, périmètre global. */
  function asAdmin() {
    prisma.user.findUnique.mockResolvedValue({ id: 'u-9', role: 'ADMIN' });
  }

  it('filtre le vendeur par statut côté serveur, liste et total compris', async () => {
    asVendor();

    await service.findRestaurantOrders('fb-1', 1, 20, 'PRET');

    const where = { restaurantId: 'r-1', status: OrderStatus.PRET };
    expect(prisma.order.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where }),
    );
    expect(prisma.order.count).toHaveBeenCalledWith({ where });
  });

  it('compte les statuts du vendeur SANS le filtre courant', async () => {
    asVendor();

    await service.findRestaurantOrders('fb-1', 1, 20, 'PRET');

    expect(prisma.order.groupBy).toHaveBeenCalledWith({
      by: ['status'],
      where: { restaurantId: 'r-1' },
      _count: { status: true },
    });
  });

  it('rend les neuf compteurs, zéro compris', async () => {
    asVendor();
    prisma.order.groupBy.mockResolvedValue([
      { status: OrderStatus.EN_ATTENTE, _count: { status: 2 } },
    ]);

    const res = await service.findRestaurantOrders('fb-1', 1, 20);

    expect(res.meta.statusCounts).toEqual({
      EN_ATTENTE: 2,
      PAYER: 0,
      ACCEPTEE: 0,
      EN_PREPARATION: 0,
      PRET: 0,
      EN_ROUTE: 0,
      LIVRER: 0,
      ANNULER: 0,
      ECHEC_LIVRAISON: 0,
    });
  });

  it('expose le total serveur dans meta', async () => {
    asVendor();
    prisma.order.count.mockResolvedValue(148);

    const res = await service.findRestaurantOrders('fb-1', 2, 20);

    expect(res.meta).toMatchObject({ total: 148, page: 2, totalPages: 8 });
  });

  it('applique le même filtre à l’ADMIN, sur le périmètre global', async () => {
    asAdmin();

    await service.findRestaurantOrders('fb-9', 1, 20, 'ANNULER');

    const where = { deleteCommande: false, status: OrderStatus.ANNULER };
    expect(prisma.order.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where }),
    );
    expect(prisma.order.groupBy).toHaveBeenCalledWith({
      by: ['status'],
      where: { deleteCommande: false },
      _count: { status: true },
    });
  });

  it('borne la recherche du vendeur à sa propre boutique', async () => {
    // Le périmètre reste `restaurantId` : une recherche ne doit jamais servir
    // de porte vers les commandes d'un concurrent.
    asVendor();

    await service.findRestaurantOrders('fb-1', 1, 20, undefined, 'Marie');

    const where = prisma.order.findMany.mock.calls[0][0].where as Record<
      string,
      unknown
    >;
    expect(where).toMatchObject({ restaurantId: 'r-1' });
    expect(where).toHaveProperty('OR');
  });

  it('fait porter les compteurs du vendeur sur le résultat de la recherche', async () => {
    asVendor();

    await service.findRestaurantOrders('fb-1', 1, 20, 'PRET', 'Marie');

    const groupByWhere = prisma.order.groupBy.mock.calls[0][0].where as Record<
      string,
      unknown
    >;
    expect(groupByWhere).toMatchObject({ restaurantId: 'r-1' });
    expect(groupByWhere).toHaveProperty('OR');
    expect(groupByWhere).not.toHaveProperty('status');
  });

  it('refuse un statut inconnu avant toute requête', async () => {
    asVendor();

    await expect(
      service.findRestaurantOrders('fb-1', 1, 20, 'PRETE'),
    ).rejects.toThrow(BadRequestException);
    expect(prisma.order.findMany).not.toHaveBeenCalled();
  });

  it('traite une chaîne vide comme « tous statuts »', async () => {
    asVendor();

    await service.findRestaurantOrders('fb-1', 1, 20, '');

    expect(prisma.order.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { restaurantId: 'r-1' } }),
    );
  });
});
