import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ForbiddenException } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';
import { AdminAuditService } from '../admin-audit/admin-audit.service';
import { RestaurantAccessService } from '../restaurants/restaurant-access.service';
import { ProductCommandService } from './product-command.service';
import { ProductValidatorService } from './product-validator.service';

/**
 * `PATCH /products/reorder`.
 *
 * Le produit était la **seule** entité ordonnable de la carte sans
 * `displayOrder` : le site triait par date de création décroissante — donc le
 * dernier plat saisi passait en tête de sa section, l'inverse de ce qu'un
 * restaurateur attend — et l'application ne triait pas du tout. Un vendeur ne
 * pouvait pas mettre son plat signature en premier.
 *
 * Les garanties testées ici sont celles de `CategoriesService.reorder`, dont
 * cette route est le décalque : propriété, isolation entre vendeurs, atomicité,
 * et refus **global** plutôt que partiel.
 */
describe('ProductCommandService.reorder', () => {
  let service: ProductCommandService;

  const prisma = {
    product: { findMany: jest.fn(), update: jest.fn() },
    user: { findUnique: jest.fn() },
    $transaction: jest.fn(),
  };
  const access = { resolveTargetRestaurant: jest.fn() };
  const audit = { record: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    access.resolveTargetRestaurant.mockResolvedValue({
      id: 'r1',
      vendorType: 'RESTAURANT',
      onBehalfOf: false,
    });
    prisma.$transaction.mockImplementation((ops: unknown[]) =>
      Promise.resolve(ops),
    );
    prisma.product.update.mockImplementation((args: unknown) => args);
    prisma.product.findMany.mockResolvedValue([]);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProductCommandService,
        { provide: PrismaService, useValue: prisma },
        { provide: ProductValidatorService, useValue: {} },
        { provide: RestaurantAccessService, useValue: access },
        { provide: AdminAuditService, useValue: audit },
        // L'invalidation du cache du site passe par un événement ;
        // ces suites testent l'écriture, pas la revalidation.
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
      ],
    }).compile();
    service = module.get(ProductCommandService);
  });

  it('pose 0, 1, 2… dans l’ordre soumis', async () => {
    prisma.product.findMany.mockResolvedValueOnce([
      { id: 'a' },
      { id: 'b' },
      { id: 'c' },
    ]);

    await service.reorder({ productIds: ['c', 'a', 'b'] }, 'uid');

    const writes = prisma.product.update.mock.calls.map((c) => c[0]);
    expect(writes).toEqual([
      { where: { id: 'c' }, data: { displayOrder: 0 } },
      { where: { id: 'a' }, data: { displayOrder: 1 } },
      { where: { id: 'b' }, data: { displayOrder: 2 } },
    ]);
  });

  it('écrit en une seule transaction', async () => {
    prisma.product.findMany.mockResolvedValueOnce([{ id: 'a' }, { id: 'b' }]);

    await service.reorder({ productIds: ['a', 'b'] }, 'uid');

    // Un réordonnancement à moitié appliqué laisserait un ordre faux que
    // personne ne verrait : c'est tout ou rien.
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.$transaction.mock.calls[0][0]).toHaveLength(2);
  });

  it('refuse EN BLOC si un produit appartient à un autre vendeur', async () => {
    // Deux ids soumis, un seul retrouvé chez ce vendeur.
    prisma.product.findMany.mockResolvedValueOnce([{ id: 'a' }]);

    await expect(
      service.reorder({ productIds: ['a', 'etranger'] }, 'uid'),
    ).rejects.toBeInstanceOf(ForbiddenException);

    // Rien n'est écrit : ignorer l'intrus en silence appliquerait un ordre
    // partiel, donc faux, sans que le vendeur le sache.
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('cherche le vendeur cible via le même arbitre que les écritures', async () => {
    prisma.product.findMany.mockResolvedValueOnce([{ id: 'a' }]);

    await service.reorder({ productIds: ['a'], restaurantId: 'autre' }, 'uid');

    // `restaurantId` n'est jamais lu directement : c'est
    // `resolveTargetRestaurant` qui décide, et il refuse à un RESTAURATEUR de
    // désigner une autre boutique.
    expect(access.resolveTargetRestaurant).toHaveBeenCalledWith('uid', 'autre');
    expect(prisma.product.findMany.mock.calls[0][0].where.restaurantId).toBe(
      'r1',
    );
  });

  it('exclut les produits retirés du catalogue', async () => {
    prisma.product.findMany.mockResolvedValueOnce([{ id: 'a' }]);

    await service.reorder({ productIds: ['a'] }, 'uid');

    // Un produit `deletedAt` n'est plus gérable ; le laisser participer
    // permettrait de le faire réapparaître dans un ordre.
    expect(prisma.product.findMany.mock.calls[0][0].where.deletedAt).toBeNull();
  });

  it('trace l’écriture quand un ADMIN agit pour un vendeur', async () => {
    access.resolveTargetRestaurant.mockResolvedValue({
      id: 'r1',
      vendorType: 'RESTAURANT',
      onBehalfOf: true,
    });
    prisma.user.findUnique.mockResolvedValue({ id: 'admin-1' });
    prisma.product.findMany.mockResolvedValueOnce([{ id: 'a' }]);

    await service.reorder({ productIds: ['a'], restaurantId: 'r1' }, 'uid');

    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(audit.record.mock.calls[0][0]).toMatchObject({
      targetType: 'Restaurant',
      targetId: 'r1',
    });
  });
});
