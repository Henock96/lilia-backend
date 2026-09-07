import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { NotFoundException } from '@nestjs/common';

import { VendorsService } from './vendors.service';
import { PrismaService } from '../../prisma/prisma.service';
import { PaginationService } from '../../common/pagination/pagination.service';
import { AdminAuditService } from '../admin-audit/admin-audit.service';
import { PUBLIC_VENDOR_WHERE } from '../../common/vendor-visibility';
import { MENU_PRODUCTS_LIMIT } from '../products/vendor-menu.include';

/**
 * `GET /vendors/:id` — **source canonique de la carte d'un vendeur** depuis la
 * phase 2 : le site et l'application la consomment toutes deux.
 *
 * Aucun test n'appelait `findOne` avant septembre 2026. `vendorDetailInclude` a
 * donc pu se mettre à lire `this.prisma`, alors qu'elle vit **hors de la
 * classe** et que `this` y vaut `undefined` : chaque consultation de boutique
 * répondait 500 en production. `tsc` laissait passer (`noImplicitAny: false`
 * rend `this` implicitement `any` dans une fonction libre) — `noImplicitThis`
 * est depuis activé, et ces tests couvrent le versant exécution.
 *
 * La leçon vaut au-delà du cas : **une méthode dont aucun test ne construit la
 * requête n'est pas couverte**, même si tout le module l'est par ailleurs.
 */
describe('VendorsService.findOne — détail vendeur', () => {
  let service: VendorsService;

  /** Un produit épuisé et un produit à stock illimité : les deux doivent sortir. */
  const PRODUITS = [
    {
      id: 'p1',
      nom: 'Poulet',
      stockRestant: 0,
      availableFrom: null,
      availableUntil: null,
    },
    {
      id: 'p2',
      nom: 'Manioc',
      stockRestant: null,
      availableFrom: null,
      availableUntil: null,
    },
  ];

  const VENDEUR = {
    id: 'v1',
    nom: 'Chez Maman Lili',
    products: PRODUITS,
    menuDuJour: [],
    _count: { products: 2 },
  };

  const prisma = {
    restaurant: { findFirst: jest.fn() },
    review: { groupBy: jest.fn() },
    // Le délégué expose ses références de colonnes : c'est ce que
    // `availableProductWhere` consomme pour comparer `availableUntil` à
    // `availableFrom` (fenêtre à cheval sur minuit).
    product: { fields: { availableFrom: 'F', availableUntil: 'U' } },
  };

  const includeOf = () =>
    prisma.restaurant.findFirst.mock.calls[0][0].include as Record<
      string,
      Record<string, unknown>
    >;

  beforeEach(async () => {
    jest.clearAllMocks();
    prisma.restaurant.findFirst.mockResolvedValue(VENDEUR);
    prisma.review.groupBy.mockResolvedValue([]);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VendorsService,
        { provide: PrismaService, useValue: prisma },
        { provide: PaginationService, useValue: {} },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
        { provide: AdminAuditService, useValue: { record: jest.fn() } },
      ],
    }).compile();
    service = module.get(VendorsService);
  });

  it('construit sa requête et rend le vendeur', async () => {
    // Le test qui manquait : il échoue par TypeError si l'include se remet à
    // lire `this` depuis une fonction libre.
    const res = await service.findOne('v1');

    expect(res.data.id).toBe('v1');
    expect(prisma.restaurant.findFirst).toHaveBeenCalledTimes(1);
  });

  it('applique la frontière marketplace', async () => {
    await service.findOne('v1');

    const args = prisma.restaurant.findFirst.mock.calls[0][0];
    expect(args.where).toMatchObject({ id: 'v1', ...PUBLIC_VENDOR_WHERE });
  });

  it('embarque produits, sections et menus du jour', async () => {
    await service.findOne('v1');

    const include = includeOf();
    expect(include.products).toBeDefined();
    expect(include.categories).toBeDefined();
    expect(include.menuDuJour).toBeDefined();
  });

  /**
   * ⚠️ **Inversion volontaire du contrat** (phase 2, 06/09/2026).
   *
   * Ce test exigeait auparavant `OR: [{ stockRestant: null }, { gt: 0 }]`,
   * c'est-à-dire l'exclusion des produits épuisés. C'était précisément la
   * divergence : le site affichait le plat avec un badge « Rupture »,
   * l'application le faisait **disparaître**. Un plat épuisé aujourd'hui est
   * quand même au menu ; le masquer laisse croire au client qu'il n'existe pas.
   *
   * Le refus de vente, lui, n'a pas bougé : il reste porté par le serveur, au
   * panier (`unavailabilityReason`) comme au checkout (`OrderValidator` +
   * décrémentation SQL conditionnelle).
   */
  it('garde les produits épuisés dans la carte, mais pas les retirés', async () => {
    await service.findOne('v1');

    const where = includeOf().products.where as Record<string, unknown>;

    expect(where).not.toHaveProperty('stockRestant');
    expect(JSON.stringify(where)).not.toContain('stockRestant');
    expect(where.deletedAt).toBeNull();
    expect(where.isAvailable).toBe(true);
  });

  it('trie et borne la carte — jamais l’ordre implicite de PostgreSQL', async () => {
    await service.findOne('v1');

    const products = includeOf().products;
    expect(products.orderBy).toEqual([
      { displayOrder: 'asc' },
      { createdAt: 'desc' },
      { id: 'asc' },
    ]);
    expect(products.take).toBe(MENU_PRODUCTS_LIMIT);
    expect((products.include as Record<string, unknown>).variants).toEqual({
      orderBy: [{ prix: 'asc' }, { id: 'asc' }],
    });
  });

  it('attache le verdict horaire du serveur à chaque produit', async () => {
    const res = await service.findOne('v1');

    // Aucune fenêtre déclarée ⇒ disponible. Le client n'a plus à le recalculer.
    expect(res.data.products.map((p) => p.availableNow)).toEqual([true, true]);
  });

  it('sert la note du vendeur — elle était absente de cette route', async () => {
    prisma.review.groupBy.mockResolvedValue([
      { restaurantId: 'v1', _avg: { rating: 4.25 }, _count: { rating: 8 } },
    ]);

    const res = await service.findOne('v1');

    expect(res.data.averageRating).toBe(4.3);
    expect(res.data.totalReviews).toBe(8);
  });

  it('annonce une carte tronquée plutôt que de la tronquer en silence', async () => {
    prisma.restaurant.findFirst.mockResolvedValue({
      ...VENDEUR,
      _count: { products: MENU_PRODUCTS_LIMIT + 1 },
    });

    const res = await service.findOne('v1');

    expect(res.data.totalProducts).toBe(MENU_PRODUCTS_LIMIT + 1);
    expect(res.data.hasMoreProducts).toBe(true);
  });

  it('404 quand le vendeur est introuvable ou non publié', async () => {
    prisma.restaurant.findFirst.mockResolvedValue(null);
    await expect(service.findOne('inconnu')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
