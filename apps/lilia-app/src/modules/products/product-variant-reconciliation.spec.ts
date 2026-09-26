import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { PrismaService } from '../../prisma/prisma.service';
import { AdminAuditService } from '../admin-audit/admin-audit.service';
import { RestaurantAccessService } from '../restaurants/restaurant-access.service';
import { ProductCommandService } from './product-command.service';
import { ProductValidatorService } from './product-validator.service';
import { PlatformSettingsService } from '../platform-settings/platform-settings.service';

/**
 * **Modifier un produit ne doit pas vider le panier des clients.**
 *
 * ## Le défaut
 *
 * `ProductCommandService.update` faisait un « détruire puis recréer » des
 * variantes :
 *
 * ```ts
 * await tx.cartItem.deleteMany({ where: { variantId: { in: oldVariantIds } } });
 * await tx.productVariant.deleteMany({ where: { productId: id } });
 * await tx.productVariant.createMany({ data: variants.map(...) });
 * ```
 *
 * Or **les deux formulaires d'administration envoient `variants` à chaque
 * enregistrement** (`apps/admin/produits/page.tsx`,
 * `lilia-food-admin/product_form_screen.dart`). Corriger une faute de frappe
 * dans une description supprimait donc le produit du panier de tous les clients
 * qui l'y avaient mis, sans qu'aucun ne soit averti — et changeait au passage
 * les identifiants de variantes, que les clients détiennent en cache.
 *
 * ## Ce que ces tests exigent
 *
 * Les variantes conservées gardent **leur identifiant**, donc leurs paniers.
 * Seules celles réellement retirées de la liste sont supprimées, et elles
 * seules emportent leurs lignes de panier — la clé étrangère l'impose.
 */
describe('ProductCommandService.update — réconciliation des variantes', () => {
  let service: ProductCommandService;

  const tx = {
    product: { update: jest.fn(), findUnique: jest.fn() },
    productVariant: {
      findMany: jest.fn(),
      update: jest.fn(),
      create: jest.fn(),
      deleteMany: jest.fn(),
      createMany: jest.fn(),
    },
    cartItem: { deleteMany: jest.fn() },
    menuProduct: { findFirst: jest.fn() },
  };

  const PRODUIT = {
    id: 'p1',
    restaurantId: 'r1',
    prixOriginal: 2500,
    productType: 'FOOD',
    availableFrom: null,
    availableUntil: null,
    stockQuotidien: null,
    restaurant: {
      vendorType: 'RESTAURANT',
      owner: { firebaseUid: 'uid-vendeur' },
    },
  };

  const prisma = {
    product: { findUnique: jest.fn() },
    user: { findUnique: jest.fn() },
    $transaction: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    prisma.product.findUnique.mockResolvedValue(PRODUIT);
    prisma.user.findUnique.mockResolvedValue({
      id: 'u1',
      role: 'RESTAURATEUR',
    });
    prisma.$transaction.mockImplementation(
      (fn: (t: typeof tx) => unknown) => fn(tx) as unknown,
    );
    tx.product.update.mockResolvedValue({ ...PRODUIT });
    tx.product.findUnique.mockResolvedValue({ ...PRODUIT, variants: [] });
    // Deux variantes en base : « Petite » (v1) et « Grande » (v2).
    tx.productVariant.findMany.mockResolvedValue([
      { id: 'v1', label: 'Petite', stockConsumption: 1 },
      { id: 'v2', label: 'Grande', stockConsumption: 1 },
    ]);
    tx.menuProduct.findFirst.mockResolvedValue(null);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProductCommandService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: PlatformSettingsService,
          useValue: {
            getSettings: async () => ({ multiUnitVariantsEnabled: false }),
          },
        },
        {
          provide: ProductValidatorService,
          useValue: {
            assertProductTypeAllowed: jest.fn(),
            assertAvailabilityWindow: jest.fn(),
          },
        },
        {
          provide: RestaurantAccessService,
          useValue: { resolveTargetRestaurant: jest.fn() },
        },
        { provide: AdminAuditService, useValue: { record: jest.fn() } },
        // L'invalidation du cache du site passe par un événement ;
        // ces suites testent l'écriture, pas la revalidation.
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
      ],
    }).compile();
    service = module.get(ProductCommandService);
  });

  it('ne touche AUCUN panier quand les variantes sont inchangées', async () => {
    await service.update(
      'p1',
      {
        description: 'Une coquille corrigée',
        variants: [
          { id: 'v1', label: 'Petite', prix: 1000 },
          { id: 'v2', label: 'Grande', prix: 1500 },
        ],
      },
      'uid-vendeur',
    );

    // C'est LE test de non-régression de ce correctif.
    expect(tx.cartItem.deleteMany).not.toHaveBeenCalled();
  });

  it('conserve les identifiants de variantes (donc les paniers et les caches)', async () => {
    await service.update(
      'p1',
      {
        variants: [
          { id: 'v1', label: 'Petite', prix: 1200 },
          { id: 'v2', prix: 1500 },
        ],
      },
      'uid-vendeur',
    );

    expect(tx.productVariant.update).toHaveBeenCalledWith({
      where: { id: 'v1' },
      data: { label: 'Petite', prix: 1200 },
    });
    expect(tx.productVariant.create).not.toHaveBeenCalled();
    // L'ancien code passait par là pour tout recréer.
    expect(tx.productVariant.createMany).not.toHaveBeenCalled();
  });

  it('ne supprime QUE les variantes réellement retirées, et leurs paniers seuls', async () => {
    await service.update(
      'p1',
      { variants: [{ id: 'v1', label: 'Petite', prix: 1000 }] },
      'uid-vendeur',
    );

    expect(tx.cartItem.deleteMany).toHaveBeenCalledWith({
      where: { variantId: { in: ['v2'] } },
    });
    expect(tx.productVariant.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ['v2'] } },
    });
    // v1 survit intacte.
    expect(tx.productVariant.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'v1' } }),
    );
  });

  it('crée les variantes nouvelles sans toucher aux anciennes', async () => {
    await service.update(
      'p1',
      {
        variants: [
          { id: 'v1', label: 'Petite', prix: 1000 },
          { id: 'v2', label: 'Grande', prix: 1500 },
          { label: 'Familiale', prix: 2500 },
        ],
      },
      'uid-vendeur',
    );

    expect(tx.productVariant.create).toHaveBeenCalledWith({
      data: {
        label: 'Familiale',
        prix: 2500,
        stockConsumption: 1,
        productId: 'p1',
      },
    });
    expect(tx.cartItem.deleteMany).not.toHaveBeenCalled();
  });

  it('traite un id inconnu comme une création, jamais comme une mise à jour', async () => {
    await service.update(
      'p1',
      {
        variants: [
          { id: 'v1', label: 'Petite', prix: 1000 },
          { id: 'v2', label: 'Grande', prix: 1500 },
          // Identifiant d'une variante appartenant à un autre produit.
          { id: 'variante-du-concurrent', label: 'Piratée', prix: 1 },
        ],
      },
      'uid-vendeur',
    );

    // Sans ce filtre, poster l'identifiant d'un tiers réécrirait SON prix.
    expect(tx.productVariant.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'variante-du-concurrent' } }),
    );
    expect(tx.productVariant.create).toHaveBeenCalledWith({
      data: { label: 'Piratée', prix: 1, stockConsumption: 1, productId: 'p1' },
    });
  });

  it('un prix omis garde celui en base — modifier un simple libellé est possible', async () => {
    await service.update(
      'p1',
      {
        variants: [
          { id: 'v1', label: 'Format éco' },
          { id: 'v2', prix: 1500 },
        ],
      },
      'uid-vendeur',
    );

    // `prix` est facultatif au DTO. L'ancien code écrivait `prix: undefined`
    // dans un `createMany`, ce qui faisait échouer toute la requête.
    expect(tx.productVariant.update).toHaveBeenCalledWith({
      where: { id: 'v1' },
      data: { label: 'Format éco' },
    });
  });

  it('une liste vide restaure la variante « Standard » au prix du produit', async () => {
    await service.update('p1', { variants: [] }, 'uid-vendeur');

    expect(tx.productVariant.create).toHaveBeenCalledWith({
      data: {
        label: 'Standard',
        prix: 2500,
        stockConsumption: 1,
        productId: 'p1',
      },
    });
    expect(tx.cartItem.deleteMany).toHaveBeenCalledWith({
      where: { variantId: { in: ['v1', 'v2'] } },
    });
  });

  it('ne touche pas aux variantes quand la requête n’en parle pas', async () => {
    await service.update('p1', { nom: 'Nouveau nom' }, 'uid-vendeur');

    expect(tx.productVariant.findMany).not.toHaveBeenCalled();
    expect(tx.productVariant.deleteMany).not.toHaveBeenCalled();
    expect(tx.cartItem.deleteMany).not.toHaveBeenCalled();
  });

  // ─── F3-10 ───────────────────────────────────────────────────────────────

  describe('F3-10 — application vendeurs qui n’envoie pas les identifiants', () => {
    it('retrouve chaque format par son libellé : aucun panier vidé, aucun identifiant changé', async () => {
      // `lilia-food-admin` : `ProductVariant.toJson()` = `{ label, prix }`.
      await service.update(
        'p1',
        {
          variants: [
            { label: 'Petite', prix: 1100 },
            { label: ' grande ', prix: 1500 },
          ],
        },
        'uid-vendeur',
      );

      expect(tx.cartItem.deleteMany).not.toHaveBeenCalled();
      expect(tx.productVariant.create).not.toHaveBeenCalled();
      expect(tx.productVariant.update).toHaveBeenCalledWith({
        where: { id: 'v1' },
        data: { label: 'Petite', prix: 1100 },
      });
    });

    it('refuse un renommage qui transformerait un carton de 6 en format à 1 unité', async () => {
      tx.productVariant.findMany.mockResolvedValue([
        { id: 'v1', label: 'Bouteille', stockConsumption: 1 },
        { id: 'v2', label: 'Carton de 6', stockConsumption: 6 },
      ]);

      await expect(
        service.update(
          'p1',
          {
            variants: [
              { label: 'Bouteille', prix: 13000 },
              { label: 'Carton 6 btl', prix: 70000 },
            ],
          },
          'uid-vendeur',
        ),
      ).rejects.toMatchObject({
        response: { code: 'VARIANTS_REQUIRE_APP_UPDATE' },
      });
      expect(tx.productVariant.deleteMany).not.toHaveBeenCalled();
    });

    it('garde la consommation d’un format retrouvé par libellé (champ absent = inchangé)', async () => {
      tx.productVariant.findMany.mockResolvedValue([
        { id: 'v2', label: 'Carton de 6', stockConsumption: 6 },
      ]);

      await service.update(
        'p1',
        { variants: [{ label: 'Carton de 6', prix: 72000 }] },
        'uid-vendeur',
      );

      expect(tx.productVariant.update).toHaveBeenCalledWith({
        where: { id: 'v2' },
        data: { label: 'Carton de 6', prix: 72000 },
      });
    });
  });

  it('F3-10 — la consommation d’un format existant ne se modifie pas (409)', async () => {
    await expect(
      service.update(
        'p1',
        {
          variants: [
            { id: 'v1', label: 'Petite', prix: 1000, stockConsumption: 6 },
          ],
        },
        'uid-vendeur',
      ),
    ).rejects.toMatchObject({
      response: { code: 'STOCK_CONSUMPTION_IMMUTABLE' },
    });
  });

  it('F3-10 — un format multi-unités est refusé tant que l’interrupteur est éteint', async () => {
    await expect(
      service.update(
        'p1',
        {
          variants: [
            { id: 'v1', label: 'Petite', prix: 1000 },
            { label: 'Carton de 6', prix: 5500, stockConsumption: 6 },
          ],
        },
        'uid-vendeur',
      ),
    ).rejects.toMatchObject({ response: { code: 'MULTI_UNIT_DISABLED' } });
  });

  it('F3-10 — un format servi par un menu ne se retire pas en silence', async () => {
    tx.menuProduct.findFirst.mockResolvedValue({ menu: { nom: 'Menu midi' } });

    await expect(
      service.update(
        'p1',
        { variants: [{ id: 'v1', label: 'Petite', prix: 1000 }] },
        'uid-vendeur',
      ),
    ).rejects.toMatchObject({ response: { code: 'VARIANT_USED_BY_MENU' } });
    expect(tx.productVariant.deleteMany).not.toHaveBeenCalled();
  });
});
