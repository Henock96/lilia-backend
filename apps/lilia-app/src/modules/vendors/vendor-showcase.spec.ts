import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { BadRequestException, NotFoundException } from '@nestjs/common';

import { VendorsService } from './vendors.service';
import { PrismaService } from '../../prisma/prisma.service';
import { PaginationService } from '../../common/pagination/pagination.service';
import { AdminAuditService } from '../admin-audit/admin-audit.service';
import {
  PUBLIC_VENDOR_ORDER_BY,
  PUBLIC_VENDOR_WHERE,
} from '../../common/vendor-visibility';

/**
 * Ordre d'affichage et mise en avant.
 *
 * La propriété qui compte n'est pas « le tri fonctionne » — c'est que **ni le
 * tri ni la mise en avant ne peuvent publier un vendeur**. `displayOrder` et
 * `isFeatured` vivent dans `orderBy` et dans le `select` ; la visibilité vit
 * dans `where`. Deux clauses SQL distinctes, qui ne peuvent pas se contaminer.
 * Ces tests le vérifient sur la requête réellement émise.
 */
describe('VendorsService — classement et mise en avant', () => {
  let service: VendorsService;

  const prisma = {
    restaurant: {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    $transaction: jest.fn((ops: unknown[]) =>
      Promise.all(ops as Promise<unknown>[]),
    ),
  };
  const audit = { record: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    prisma.restaurant.findMany.mockResolvedValue([]);
    prisma.restaurant.count.mockResolvedValue(0);
    prisma.$transaction.mockImplementation((ops: unknown[]) =>
      Promise.all(ops as Promise<unknown>[]),
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VendorsService,
        { provide: PrismaService, useValue: prisma },
        { provide: PaginationService, useValue: {} },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
        { provide: AdminAuditService, useValue: audit },
      ],
    }).compile();
    service = module.get(VendorsService);
  });

  // ─── Le tri ────────────────────────────────────────────────────────────────

  describe('findAll — ordre', () => {
    it('trie par [isOpen desc, displayOrder asc, isFeatured desc, createdAt desc]', async () => {
      await service.findAll({} as never);
      expect(prisma.restaurant.findMany.mock.calls[0][0].orderBy).toEqual([
        { isOpen: 'desc' },
        { displayOrder: 'asc' },
        { isFeatured: 'desc' },
        { createdAt: 'desc' },
      ]);
    });

    /**
     * Le défaut à l'origine de ce test : la home du site consommait
     * `?isFeatured=true`, et mettre un vendeur en avant faisait disparaître
     * tous les autres de la page d'accueil.
     *
     * La mise en avant doit **classer** sans filtrer. Elle appartient donc à
     * `orderBy`, jamais à un `where` implicite — sans quoi le seul moyen de
     * « remonter » un vendeur serait d'effacer les autres.
     */
    it('la mise en avant classe le vendeur, elle ne l’isole pas de la liste', async () => {
      await service.findAll({} as never);
      const call = prisma.restaurant.findMany.mock.calls[0][0];

      expect(call.orderBy).toContainEqual({ isFeatured: 'desc' });
      // Aucun filtre implicite : la liste par défaut reste le catalogue entier.
      expect(call.where).not.toHaveProperty('isFeatured');
      // La précédence, dans l'ordre : « ouvert maintenant » d'abord — un
      // vendeur fermé ne remonte pas devant un vendeur chez qui on peut
      // commander tout de suite ; puis `displayOrder`, position explicite
      // décidée par l'administrateur, que la vedette ne défait pas ; la mise
      // en avant ne fait que départager ceux qu'il n'a pas rangés.
      const at = (key: string) =>
        (call.orderBy as Record<string, string>[]).findIndex((o) => key in o);
      expect(at('isOpen')).toBeGreaterThanOrEqual(0);
      expect(at('isOpen')).toBeLessThan(at('displayOrder'));
      expect(at('displayOrder')).toBeLessThan(at('isFeatured'));
      expect(at('isFeatured')).toBeLessThan(at('createdAt'));
    });

    /**
     * `GET /restaurants` et `GET /vendors` listaient la même entité avec deux
     * ordres différents. La constante partagée est la seule garantie qu'ils ne
     * redivergent pas : ce test la relie à la requête effective.
     */
    it('l’ordre provient de la constante partagée avec GET /restaurants', async () => {
      await service.findAll({} as never);
      expect(prisma.restaurant.findMany.mock.calls[0][0].orderBy).toEqual([
        ...PUBLIC_VENDOR_ORDER_BY,
      ]);
    });
  });

  // ─── La frontière de visibilité ────────────────────────────────────────────

  describe('findAll — visibilité', () => {
    it('applique toujours les trois conditions de visibilité', async () => {
      await service.findAll({} as never);
      expect(prisma.restaurant.findMany.mock.calls[0][0].where).toMatchObject(
        PUBLIC_VENDOR_WHERE,
      );
    });

    /**
     * Le scénario du TEST 11 de la demande : un vendeur DRAFT, classé premier
     * et mis en avant, doit rester invisible. Le `where` conserve
     * `onboardingStatus: ACTIVATED` — donc la base ne le rendra jamais, quelles
     * que soient les deux autres colonnes.
     */
    it('isFeatured s’AJOUTE à la visibilité, il ne s’y substitue pas', async () => {
      await service.findAll({ isFeatured: true } as never);
      const where = prisma.restaurant.findMany.mock.calls[0][0].where;
      expect(where).toMatchObject({ ...PUBLIC_VENDOR_WHERE, isFeatured: true });
      expect(where.onboardingStatus).toBe('ACTIVATED');
      expect(where.adminApproved).toBe(true);
      expect(where.isActive).toBe(true);
    });

    it('sans le filtre, `isFeatured` n’apparaît pas dans le where', async () => {
      await service.findAll({} as never);
      expect(
        prisma.restaurant.findMany.mock.calls[0][0].where,
      ).not.toHaveProperty('isFeatured');
    });
  });

  // ─── Les écritures d'administration ────────────────────────────────────────

  describe('setDisplayOrder', () => {
    it('n’écrit QUE displayOrder — aucun champ de visibilité', async () => {
      prisma.restaurant.findUnique.mockResolvedValue({
        id: 'r1',
        nom: 'A',
        displayOrder: 1000,
      });
      prisma.restaurant.update.mockResolvedValue({
        id: 'r1',
        nom: 'A',
        displayOrder: 2,
        isFeatured: false,
      });

      await service.setDisplayOrder('r1', 2, 'admin-1');

      expect(prisma.restaurant.update.mock.calls[0][0].data).toEqual({
        displayOrder: 2,
      });
    });

    it('trace l’ancienne et la nouvelle position dans le journal d’audit', async () => {
      prisma.restaurant.findUnique.mockResolvedValue({
        id: 'r1',
        nom: 'A',
        displayOrder: 1000,
      });
      prisma.restaurant.update.mockResolvedValue({ id: 'r1', nom: 'A' });

      await service.setDisplayOrder('r1', 3, 'admin-1');

      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ metadata: { from: 1000, to: 3 } }),
      );
    });

    it('vendeur inconnu → 404', async () => {
      prisma.restaurant.findUnique.mockResolvedValue(null);
      await expect(
        service.setDisplayOrder('nope', 1, 'a'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('setFeatured', () => {
    it('n’écrit QUE isFeatured', async () => {
      prisma.restaurant.findUnique.mockResolvedValue({
        id: 'r1',
        nom: 'A',
        isFeatured: false,
      });
      prisma.restaurant.update.mockResolvedValue({ id: 'r1', nom: 'A' });

      await service.setFeatured('r1', true, 'admin-1');

      expect(prisma.restaurant.update.mock.calls[0][0].data).toEqual({
        isFeatured: true,
      });
    });

    it('valeur déjà posée → 400 (pas d’écriture ni d’audit à vide)', async () => {
      prisma.restaurant.findUnique.mockResolvedValue({
        id: 'r1',
        nom: 'A',
        isFeatured: true,
      });
      await expect(service.setFeatured('r1', true, 'a')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(prisma.restaurant.update).not.toHaveBeenCalled();
    });
  });

  /**
   * L'indépendance demandée : un vendeur peut être 1er sans badge, ou 10e avec.
   * Les deux routes n'écrivent jamais la colonne de l'autre — c'est ce qui rend
   * les deux notions réellement orthogonales, plutôt que « orthogonales sauf si
   * on oublie ».
   */
  it('displayOrder et isFeatured sont écrits indépendamment', async () => {
    prisma.restaurant.findUnique.mockResolvedValue({
      id: 'r1',
      nom: 'A',
      displayOrder: 1000,
      isFeatured: false,
    });
    prisma.restaurant.update.mockResolvedValue({ id: 'r1', nom: 'A' });

    await service.setDisplayOrder('r1', 10, 'a');
    expect(prisma.restaurant.update.mock.calls[0][0].data).not.toHaveProperty(
      'isFeatured',
    );

    prisma.restaurant.update.mockClear();
    await service.setFeatured('r1', true, 'a');
    expect(prisma.restaurant.update.mock.calls[0][0].data).not.toHaveProperty(
      'displayOrder',
    );
  });
});
