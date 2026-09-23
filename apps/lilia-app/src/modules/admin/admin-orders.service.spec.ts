import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { OrderStatus } from '@prisma/client';

import { AdminOrdersService } from './admin-orders.service';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * `GET /admin/orders` existait depuis des mois, gardé et paginé — et n'avait
 * **aucun appelant**. Les deux administrations lisaient `GET /orders/restaurant`
 * sans transmettre de pagination, donc n'affichaient que les vingt dernières
 * commandes de toute la plateforme (audit du 09/09/2026, blocker n°1).
 *
 * Ces tests figent le contrat que les fronts vont consommer. Trois propriétés
 * y sont exigibles, et chacune correspond à un défaut observé :
 *
 *  1. `meta.total` — sans lui, un front compte les éléments reçus et annonce
 *     donc la taille de la page. C'est ce qui faisait afficher « 20 » quand
 *     cinquante clients attendaient (même défaut que le badge remboursements) ;
 *  2. `meta.statusCounts` — les onglets comptaient dans la page courante. Un
 *     compteur calculé sur un échantillon arbitraire est pire qu'absent ;
 *  3. le filtre de statut est appliqué **par le serveur**. Filtrer une page
 *     déjà tronquée ne rend que les commandes de cette page.
 */
describe('AdminOrdersService.list', () => {
  let service: AdminOrdersService;
  let prisma: {
    order: {
      findMany: jest.Mock;
      count: jest.Mock;
      groupBy: jest.Mock;
    };
  };

  beforeEach(async () => {
    prisma = {
      order: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        groupBy: jest.fn().mockResolvedValue([]),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminOrdersService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get(AdminOrdersService);
  });

  it('rend l’enveloppe conforme { data, meta } avec le total serveur', async () => {
    prisma.order.findMany.mockResolvedValue([{ id: 'o1' }]);
    prisma.order.count.mockResolvedValue(148);

    const res = await service.list({ page: 2, limit: 20 });

    expect(res.data).toEqual([{ id: 'o1' }]);
    expect(res.meta).toMatchObject({
      total: 148,
      page: 2,
      limit: 20,
      totalPages: 8,
    });
  });

  it('traduit page et limit en skip / take', async () => {
    await service.list({ page: 3, limit: 25 });

    expect(prisma.order.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 50, take: 25 }),
    );
  });

  it('exclut les commandes effacées par le client, liste et total compris', async () => {
    await service.list({});

    expect(prisma.order.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { deleteCommande: false } }),
    );
    expect(prisma.order.count).toHaveBeenCalledWith({
      where: { deleteCommande: false },
    });
  });

  it('applique le filtre de statut à la liste ET au total', async () => {
    await service.list({ status: 'PRET' });

    const where = { deleteCommande: false, status: OrderStatus.PRET };
    expect(prisma.order.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where }),
    );
    expect(prisma.order.count).toHaveBeenCalledWith({ where });
  });

  it('compte les statuts SANS le filtre courant', async () => {
    // Sinon, sélectionner l'onglet « Prêt » remettrait tous les autres
    // compteurs à zéro : l'interface annoncerait qu'il n'y a plus rien à
    // préparer au moment précis où on regarde autre chose.
    await service.list({ status: 'PRET' });

    expect(prisma.order.groupBy).toHaveBeenCalledWith({
      by: ['status'],
      where: { deleteCommande: false },
      _count: { status: true },
    });
  });

  it('rend un compteur par statut, zéro compris', async () => {
    prisma.order.groupBy.mockResolvedValue([
      { status: OrderStatus.PRET, _count: { status: 4 } },
      { status: OrderStatus.LIVRER, _count: { status: 31 } },
    ]);

    const res = await service.list({});

    // Les neuf clés sont présentes : un front ne doit pas avoir à deviner
    // qu'une absence vaut zéro.
    expect(res.meta.statusCounts).toEqual({
      EN_ATTENTE: 0,
      PAYER: 0,
      ACCEPTEE: 0,
      EN_PREPARATION: 0,
      PRET: 4,
      EN_ROUTE: 0,
      LIVRER: 31,
      ANNULER: 0,
      ECHEC_LIVRAISON: 0,
    });
  });

  it('refuse un statut inconnu au lieu de le laisser filer vers Prisma', async () => {
    // `status as any` produisait une erreur Prisma opaque en 500. Un 400 qui
    // nomme les valeurs acceptées est lisible depuis le client.
    await expect(service.list({ status: 'PRETE' })).rejects.toThrow(
      BadRequestException,
    );
    expect(prisma.order.findMany).not.toHaveBeenCalled();
  });

  it('ignore un statut vide — c’est la vue « tous statuts »', async () => {
    await service.list({ status: '' });

    expect(prisma.order.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { deleteCommande: false } }),
    );
  });

  it('applique la recherche à la liste et au total', async () => {
    await service.list({ search: 'Marie' });

    const expected = {
      deleteCommande: false,
      OR: expect.any(Array) as unknown,
    };
    expect(prisma.order.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expected }),
    );
    expect(prisma.order.count).toHaveBeenCalledWith({ where: expected });
  });

  it('fait porter les compteurs d’onglets sur le résultat de la recherche', async () => {
    // La recherche définit le périmètre, le statut n'en est qu'une facette :
    // chercher « Marie » doit dire combien de commandes de Marie sont dans
    // chaque statut, pas combien il y en a dans toute la plateforme.
    await service.list({ search: 'Marie', status: 'PRET' });

    const groupByArgs = prisma.order.groupBy.mock.calls[0][0] as {
      where: Record<string, unknown>;
    };
    expect(groupByArgs.where).toHaveProperty('OR');
    expect(groupByArgs.where).toMatchObject({ deleteCommande: false });
    // Le statut, lui, reste exclu du comptage.
    expect(groupByArgs.where).not.toHaveProperty('status');
  });

  it('combine recherche et statut sur la liste', async () => {
    await service.list({ search: 'Marie', status: 'PRET' });

    const where = prisma.order.findMany.mock.calls[0][0].where as Record<
      string,
      unknown
    >;
    expect(where).toMatchObject({
      deleteCommande: false,
      status: OrderStatus.PRET,
    });
    expect(where).toHaveProperty('OR');
  });

  it('ignore une recherche vide', async () => {
    await service.list({ search: '   ' });

    expect(prisma.order.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { deleteCommande: false } }),
    );
  });

  it('charge le client, le vendeur et la course avec chaque commande', async () => {
    // L'écran de supervision doit pouvoir rappeler le client et savoir qui
    // porte la commande. Sans ces relations, un incident se traite en
    // rouvrant Prisma Studio.
    await service.list({});

    const include = prisma.order.findMany.mock.calls[0][0].include;
    expect(include.user.select).toMatchObject({ nom: true, phone: true });
    expect(include.restaurant.select).toMatchObject({ nom: true });
    expect(include.delivery.select).toMatchObject({ status: true });
    expect(include.items).toBeDefined();
  });
});
