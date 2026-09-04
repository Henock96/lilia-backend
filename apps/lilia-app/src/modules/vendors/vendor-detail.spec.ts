import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { NotFoundException } from '@nestjs/common';

import { VendorsService } from './vendors.service';
import { PrismaService } from '../../prisma/prisma.service';
import { PaginationService } from '../../common/pagination/pagination.service';
import { AdminAuditService } from '../admin-audit/admin-audit.service';
import { PUBLIC_VENDOR_WHERE } from '../../common/vendor-visibility';

/**
 * `GET /vendors/:id` — l'écran de détail vendeur du client.
 *
 * Aucun test n'appelait `findOne`. `vendorDetailInclude` a donc pu se mettre à
 * lire `this.prisma`, alors qu'elle vit **hors de la classe** et que `this` y
 * vaut `undefined` : chaque consultation de boutique répondait 500 en
 * production. `tsc` laissait passer (`noImplicitAny: false` rend `this`
 * implicitement `any` dans une fonction libre) — `noImplicitThis` est depuis
 * activé, et ces tests couvrent le versant exécution.
 *
 * La leçon vaut au-delà du cas : **une méthode dont aucun test ne construit la
 * requête n'est pas couverte**, même si tout le module l'est par ailleurs.
 */
describe('VendorsService.findOne — détail vendeur', () => {
  let service: VendorsService;

  const VENDEUR = {
    id: 'v1',
    nom: 'Chez Maman Lili',
    products: [],
    menuDuJour: [],
  };

  const prisma = {
    restaurant: { findFirst: jest.fn() },
    // Le délégué expose ses références de colonnes : c'est ce que
    // `availableProductWhere` consomme pour comparer `availableUntil` à
    // `availableFrom` (fenêtre à cheval sur minuit).
    product: { fields: { availableFrom: 'F', availableUntil: 'U' } },
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    prisma.restaurant.findFirst.mockResolvedValue(VENDEUR);

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

    expect(res.data).toBe(VENDEUR);
    expect(prisma.restaurant.findFirst).toHaveBeenCalledTimes(1);
  });

  it('applique la frontière marketplace', async () => {
    await service.findOne('v1');

    const args = prisma.restaurant.findFirst.mock.calls[0][0];
    expect(args.where).toMatchObject({ id: 'v1', ...PUBLIC_VENDOR_WHERE });
  });

  it('embarque produits, sections et menus du jour', async () => {
    await service.findOne('v1');

    const include = prisma.restaurant.findFirst.mock.calls[0][0].include;
    expect(include.products).toBeDefined();
    expect(include.categories).toBeDefined();
    expect(include.menuDuJour).toBeDefined();
  });

  it('filtre les produits sur le stock ET sur leur disponibilité', async () => {
    await service.findOne('v1');

    const where = prisma.restaurant.findFirst.mock.calls[0][0].include.products
      .where as Record<string, unknown>;
    // Les deux conditions cohabitent : le `OR` du stock ne doit pas écraser
    // celui de la fenêtre horaire, porté par le `AND`.
    expect(where.OR).toEqual([
      { stockRestant: null },
      { stockRestant: { gt: 0 } },
    ]);
    const et = (where.AND as Record<string, unknown>[])[0];
    expect(et.deletedAt).toBeNull();
    expect(et.isAvailable).toBe(true);
  });

  it('404 quand le vendeur est introuvable ou non publié', async () => {
    prisma.restaurant.findFirst.mockResolvedValue(null);
    await expect(service.findOne('inconnu')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
