import { ForbiddenException, NotFoundException } from '@nestjs/common';

import { CategoriesService } from './categories.service';

/**
 * Table d'autorisation des sections de menu.
 *
 * Ce fichier existe parce que le défaut d'origine était **structurel** : la
 * table `Category` n'avait pas de propriétaire, `PATCH /categories/:id` était
 * ouvert au rôle RESTAURATEUR, et aucun test ne pouvait donc échouer — il n'y
 * avait rien à contrôler. Le rôle était vérifié, l'objet jamais.
 *
 * Les quatre colonnes reprennent celles de `restaurants.authorization.spec.ts` :
 * propriétaire / autre propriétaire / autre rôle / admin.
 */
describe('CategoriesService — autorisation', () => {
  const OWNER_A = { id: 'user-a', role: 'RESTAURATEUR' as const };
  const OWNER_B = { id: 'user-b', role: 'RESTAURATEUR' as const };
  const ADMIN = { id: 'user-admin', role: 'ADMIN' as const };

  /** Section appartenant au vendeur du propriétaire A. */
  const CATEGORY_OF_A = {
    id: 'cat-a',
    nom: 'Boissons',
    slug: 'boissons',
    restaurantId: 'resto-a',
    displayOrder: 0,
    isActive: true,
    restaurant: { ownerId: OWNER_A.id },
  };

  function build(caller: { id: string; role: 'RESTAURATEUR' | 'ADMIN' }) {
    const prisma = {
      category: {
        findUnique: jest.fn().mockResolvedValue(CATEGORY_OF_A),
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue(null),
        update: jest
          .fn()
          .mockResolvedValue({ ...CATEGORY_OF_A, nom: 'Renommée' }),
        create: jest.fn().mockResolvedValue(CATEGORY_OF_A),
        delete: jest.fn().mockResolvedValue(CATEGORY_OF_A),
      },
      product: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      user: { findUnique: jest.fn().mockResolvedValue(caller) },
      restaurant: { findFirst: jest.fn().mockResolvedValue(null) },
      $transaction: jest.fn(async (arg: unknown) =>
        typeof arg === 'function'
          ? (arg as (tx: unknown) => unknown)({
              product: {
                updateMany: jest.fn().mockResolvedValue({ count: 3 }),
              },
              category: { delete: jest.fn() },
            })
          : arg,
      ),
    };
    const access = {
      resolveTargetRestaurant: jest.fn(),
    };
    const audit = { record: jest.fn() };

    const service = new CategoriesService(
      prisma as never,
      access as never,
      audit as never,
      { emit: jest.fn() } as never,
    );
    return { service, prisma, access, audit };
  }

  describe('PATCH — modifier une section', () => {
    it('le propriétaire modifie la sienne', async () => {
      const { service, prisma } = build(OWNER_A);
      await expect(
        service.update('cat-a', { nom: 'Renommée' }, 'fb-a'),
      ).resolves.toMatchObject({ message: expect.any(String) });
      expect(prisma.category.update).toHaveBeenCalled();
    });

    it("un AUTRE propriétaire est refusé, même en connaissant l'id", async () => {
      // Le cœur du défaut : les ids de section transitaient par une route
      // publique, et rien ne rattachait la section à un commerce.
      const { service, prisma } = build(OWNER_B);
      await expect(
        service.update('cat-a', { nom: 'Squattée' }, 'fb-b'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.category.update).not.toHaveBeenCalled();
    });

    it("l'admin modifie n'importe laquelle", async () => {
      const { service, prisma } = build(ADMIN);
      await service.update('cat-a', { nom: 'Corrigée' }, 'fb-admin');
      expect(prisma.category.update).toHaveBeenCalled();
    });

    it('404 si la section n’existe pas — avant tout contrôle de rôle', async () => {
      // Un id inexistant ne doit pas se distinguer d'un id appartenant à
      // autrui : sinon la route devient un oracle d'existence.
      const { service, prisma } = build(OWNER_B);
      prisma.category.findUnique.mockResolvedValue(null);
      await expect(
        service.update('cat-inconnue', { nom: 'X' }, 'fb-b'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('DELETE — supprimer une section', () => {
    it('le propriétaire supprime la sienne, et les produits sont DÉTACHÉS', async () => {
      const { service, prisma } = build(OWNER_A);
      const res = await service.remove('cat-a', 'fb-a');
      // La règle métier : supprimer une section ne supprime jamais un produit.
      expect(res.data.detachedProducts).toBe(3);
      expect(prisma.$transaction).toHaveBeenCalled();
    });

    it('un autre propriétaire est refusé', async () => {
      const { service, prisma } = build(OWNER_B);
      await expect(service.remove('cat-a', 'fb-b')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it("l'admin supprime n'importe laquelle", async () => {
      const { service, prisma } = build(ADMIN);
      await service.remove('cat-a', 'fb-admin');
      expect(prisma.$transaction).toHaveBeenCalled();
    });
  });

  describe('POST — créer une section', () => {
    it('le vendeur cible vient de resolveTargetRestaurant, jamais du corps', async () => {
      // C'est la règle qui rend inutile de faire confiance au `restaurantId`
      // envoyé : le service ne le lit pas, il le passe au résolveur qui décide.
      const { service, access, prisma } = build(OWNER_A);
      access.resolveTargetRestaurant.mockResolvedValue({
        id: 'resto-a',
        vendorType: 'RESTAURANT',
        onBehalfOf: false,
      });
      prisma.category.findFirst.mockResolvedValue(null);

      await service.create(
        { nom: 'Desserts', restaurantId: 'resto-b' },
        'fb-a',
      );

      expect(access.resolveTargetRestaurant).toHaveBeenCalledWith(
        'fb-a',
        'resto-b',
      );
      expect(prisma.category.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            restaurantId: 'resto-a',
            slug: 'desserts',
          }),
        }),
      );
    });

    it("trace l'écriture quand un ADMIN agit au nom d'un tiers", async () => {
      const { service, access, audit, prisma } = build(ADMIN);
      access.resolveTargetRestaurant.mockResolvedValue({
        id: 'resto-b',
        vendorType: 'RESTAURANT',
        onBehalfOf: true,
      });
      prisma.category.findFirst.mockResolvedValue(null);

      await service.create(
        { nom: 'Desserts', restaurantId: 'resto-b' },
        'fb-admin',
      );

      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ targetId: 'resto-b' }),
      );
    });
  });

  describe('PATCH /reorder', () => {
    it('refuse la liste si un id appartient à un autre vendeur', async () => {
      // Un identifiant étranger fait échouer l'appel ENTIER : appliquer
      // partiellement un réordonnancement laisserait un ordre que personne
      // n'a demandé.
      const { service, access, prisma } = build(OWNER_A);
      access.resolveTargetRestaurant.mockResolvedValue({
        id: 'resto-a',
        vendorType: 'RESTAURANT',
        onBehalfOf: false,
      });
      prisma.category.findMany.mockResolvedValue([{ id: 'cat-a' }]); // 1 sur 2

      await expect(
        service.reorder({ categoryIds: ['cat-a', 'cat-etrangere'] }, 'fb-a'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('pose des positions contiguës 0,1,2 sur la liste fournie', async () => {
      const { service, access, prisma } = build(OWNER_A);
      access.resolveTargetRestaurant.mockResolvedValue({
        id: 'resto-a',
        vendorType: 'RESTAURANT',
        onBehalfOf: false,
      });
      prisma.category.findMany.mockResolvedValue([
        { id: 'c1' },
        { id: 'c2' },
        { id: 'c3' },
      ]);

      await service.reorder({ categoryIds: ['c3', 'c1', 'c2'] }, 'fb-a');

      expect(prisma.category.update).toHaveBeenNthCalledWith(1, {
        where: { id: 'c3' },
        data: { displayOrder: 0 },
      });
      expect(prisma.category.update).toHaveBeenNthCalledWith(2, {
        where: { id: 'c1' },
        data: { displayOrder: 1 },
      });
      expect(prisma.category.update).toHaveBeenNthCalledWith(3, {
        where: { id: 'c2' },
        data: { displayOrder: 2 },
      });
    });
  });

  describe('GET — vue propriétaire', () => {
    it('ne filtre PAS sur la présence de produits', async () => {
      // Le filtre historique (`products: { some: ... }`) faisait disparaître
      // une section à la seconde où on la créait : elle ne pouvait donc jamais
      // être remplie.
      const { service, access, prisma } = build(OWNER_A);
      access.resolveTargetRestaurant.mockResolvedValue({
        id: 'resto-a',
        vendorType: 'RESTAURANT',
        onBehalfOf: false,
      });

      await service.findAllForOwner('fb-a');

      const where = prisma.category.findMany.mock.calls[0][0].where;
      expect(where).toEqual({ restaurantId: 'resto-a' });
      expect(JSON.stringify(where)).not.toContain('some');
    });
  });
});
