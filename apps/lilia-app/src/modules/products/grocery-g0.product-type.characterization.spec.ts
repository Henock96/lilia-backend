import { BadRequestException } from '@nestjs/common';
import { ProductType, VendorType } from '@prisma/client';

import { catalogProductWhere } from './product-availability';
import { ProductCommandService } from './product-command.service';
import { ProductValidatorService } from './product-validator.service';

/**
 * G0 — caractérisation du type de produit, avant l'extension aux épiceries.
 *
 * Ces tests décrivent le comportement **actuel**, pas le comportement voulu.
 * Quand un cas documente un défaut connu, son titre commence par
 * « [ACTUEL] » et cite le constat de la discovery
 * (`lilia-engineering/features/2026-10-10-grocery-marketplace/`). Le jour où
 * le défaut est corrigé, le test doit échouer : c'est voulu, il faudra le
 * réécrire en même temps que le correctif, pas avant.
 */

/**
 * Matrice attendue, recopiée À LA MAIN depuis le comportement observé le
 * 10/10/2026. Elle n'importe pas `VENDOR_PRODUCT_MATRIX` : un test qui lirait
 * la constante qu'il vérifie ne pourrait jamais échouer.
 */
const EXPECTED_ALLOWED: Record<VendorType, ProductType[]> = {
  RESTAURANT: [ProductType.FOOD, ProductType.BEVERAGE],
  HOME_COOK: [ProductType.FOOD, ProductType.PASTRY],
  BAKERY: [ProductType.PASTRY, ProductType.FOOD],
  BEVERAGE_SHOP: [ProductType.BEVERAGE],
  GROCERY: [ProductType.GROCERY, ProductType.BEVERAGE],
};

describe('G0 — R-01 matrice vendeur ↔ type de produit (serveur)', () => {
  const validator = new ProductValidatorService();

  it('les enums couvrent exactement 5 types de vendeur et 5 types de produit', () => {
    // Si un type est ajouté, la matrice ci-dessous doit être revue — et les
    // apps installées le liraient comme RESTAURANT / FOOD (`fromString`).
    expect(Object.values(VendorType).sort()).toEqual([
      'BAKERY',
      'BEVERAGE_SHOP',
      'GROCERY',
      'HOME_COOK',
      'RESTAURANT',
    ]);
    expect(Object.values(ProductType).sort()).toEqual([
      'ALCOHOL',
      'BEVERAGE',
      'FOOD',
      'GROCERY',
      'PASTRY',
    ]);
  });

  const cases = Object.values(VendorType).flatMap((vendorType) =>
    Object.values(ProductType).map((productType) => ({
      vendorType,
      productType,
      allowed: EXPECTED_ALLOWED[vendorType].includes(productType),
    })),
  );

  it.each(cases)(
    '$vendorType × $productType → autorisé = $allowed',
    ({ vendorType, productType, allowed }) => {
      const call = () =>
        validator.assertProductTypeAllowed(vendorType, productType);
      if (allowed) expect(call).not.toThrow();
      else expect(call).toThrow(BadRequestException);
    },
  );

  it('GROCERY : seules GROCERY et BEVERAGE passent', () => {
    const accepted = Object.values(ProductType).filter((t) => {
      try {
        validator.assertProductTypeAllowed(VendorType.GROCERY, t);
        return true;
      } catch {
        return false;
      }
    });
    expect(accepted.sort()).toEqual(['BEVERAGE', 'GROCERY']);
  });
});

/**
 * Service de commande produit monté avec le VRAI validateur : c'est la
 * combinaison « défaut du service + matrice » qui décide du 400, pas l'un ou
 * l'autre seul.
 */
function buildCommand(vendorType: VendorType) {
  const created: Array<Record<string, unknown>> = [];
  const tx = {
    product: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        created.push(data);
        return { id: 'p1' };
      }),
      findUnique: jest.fn().mockResolvedValue({ id: 'p1', variants: [] }),
      update: jest.fn().mockResolvedValue({ id: 'p1', prixOriginal: 800 }),
    },
    productVariant: { createMany: jest.fn() },
  };
  const prisma = {
    category: { findUnique: jest.fn() },
    product: { findUnique: jest.fn(), update: jest.fn() },
    user: { findUnique: jest.fn() },
    $transaction: jest.fn(async (fn: (t: unknown) => unknown) => fn(tx)),
  };
  const access = {
    resolveTargetRestaurant: jest
      .fn()
      .mockResolvedValue({ id: 'v1', vendorType, onBehalfOf: false }),
  };
  const service = new ProductCommandService(
    prisma as never,
    new ProductValidatorService(),
    access as never,
    { record: jest.fn() } as never,
    { emit: jest.fn() } as never,
    { getSettings: async () => ({ multiUnitVariantsEnabled: false }) } as never,
  );
  return { service, prisma, created };
}

describe('G0 — R-02 type de produit par défaut (serveur, POST /products)', () => {
  const dto = { nom: 'Article', prixOriginal: 1000 };

  it.each([VendorType.RESTAURANT, VendorType.HOME_COOK, VendorType.BAKERY])(
    '%s sans productType → 201, enregistré FOOD',
    async (vendorType) => {
      const { service, created } = buildCommand(vendorType);
      await expect(service.create({ ...dto }, 'fb')).resolves.toBeDefined();
      expect(created[0].productType).toBe(ProductType.FOOD);
    },
  );

  it.each([VendorType.GROCERY, VendorType.BEVERAGE_SHOP])(
    '[ACTUEL — F-02] %s sans productType → 400 (le défaut FOOD sort de la matrice)',
    async (vendorType) => {
      const { service, created } = buildCommand(vendorType);
      await expect(service.create({ ...dto }, 'fb')).rejects.toThrow(
        BadRequestException,
      );
      await expect(service.create({ ...dto }, 'fb')).rejects.toThrow(
        /ne peut pas vendre des produits FOOD/,
      );
      // Refus AVANT toute écriture.
      expect(created).toHaveLength(0);
    },
  );
});

describe('G0 — R-04 produit d’un vendeur GROCERY (serveur)', () => {
  it('productType GROCERY + stock réel : 201, colonnes de stock cohérentes', async () => {
    const { service, created } = buildCommand(VendorType.GROCERY);
    await service.create(
      {
        nom: 'Lait en poudre 400 g',
        prixOriginal: 3500,
        productType: ProductType.GROCERY,
        stockPolicy: 'INVENTORY',
        stockQuotidien: 24,
        stockUnit: 'PIECE',
      },
      'fb',
    );
    expect(created[0]).toMatchObject({
      productType: ProductType.GROCERY,
      stockPolicy: 'INVENTORY',
      stockRestant: 24,
      stockUnit: 'PIECE',
    });
  });

  it('productType BEVERAGE : 201', async () => {
    const { service, created } = buildCommand(VendorType.GROCERY);
    await service.create(
      {
        nom: 'Eau 1,5 L',
        prixOriginal: 500,
        productType: ProductType.BEVERAGE,
      },
      'fb',
    );
    expect(created[0].productType).toBe(ProductType.BEVERAGE);
  });

  it('[ACTUEL] sans stockPolicy → UNLIMITED, même pour une épicerie', async () => {
    // Le défaut serveur ne dépend pas du type de vendeur : une référence
    // d'étagère saisie sans stock est vendable à l'infini.
    const { service, created } = buildCommand(VendorType.GROCERY);
    await service.create(
      { nom: 'Riz 5 kg', prixOriginal: 6000, productType: ProductType.GROCERY },
      'fb',
    );
    expect(created[0]).toMatchObject({
      stockPolicy: 'UNLIMITED',
      stockRestant: null,
    });
  });
});

describe('G0 — R-06 ALCOHOL', () => {
  it.each(Object.values(VendorType))(
    'création ALCOHOL chez %s → 400 « alcool », rien n’est écrit',
    async (vendorType) => {
      const { service, created } = buildCommand(vendorType);
      await expect(
        service.create(
          { nom: 'Bière', prixOriginal: 800, productType: ProductType.ALCOHOL },
          'fb',
        ),
      ).rejects.toThrow(/alcool/i);
      expect(created).toHaveLength(0);
    },
  );

  function buildUpdate(existingType: ProductType) {
    const { service, prisma } = buildCommand(VendorType.GROCERY);
    prisma.product.findUnique.mockResolvedValue({
      id: 'p1',
      restaurantId: 'v1',
      productType: existingType,
      availableFrom: null,
      availableUntil: null,
      restaurant: {
        vendorType: VendorType.GROCERY,
        owner: { firebaseUid: 'fb' },
      },
    });
    prisma.user.findUnique.mockResolvedValue({ id: 'u', role: 'RESTAURATEUR' });
    return service;
  }

  it('modification vers ALCOHOL → 400 avant toute écriture', async () => {
    const service = buildUpdate(ProductType.GROCERY);
    await expect(
      service.update('p1', { productType: ProductType.ALCOHOL }, 'fb'),
    ).rejects.toThrow(/alcool/i);
  });

  it('[ACTUEL] un produit déjà ALCOHOL en base n’est pas revalidé si productType n’est pas renvoyé', async () => {
    // `update` ne relance la matrice que si `dto.productType` CHANGE. Une
    // ligne ALCOHOL écrite hors service (script, SQL manuel) passe donc une
    // modification de nom sans être bloquée : la mise à jour aboutit.
    const service = buildUpdate(ProductType.ALCOHOL);
    const outcome = await service
      .update('p1', { nom: 'Bière blonde' }, 'fb')
      .then(
        () => 'accepté',
        (e: Error) => (/alcool/i.test(e.message) ? 'refus alcool' : 'autre'),
      );
    expect(outcome).toBe('accepté');
  });

  it('[ACTUEL] le filtre du catalogue public n’exclut aucun productType', () => {
    // Défense en profondeur absente : seule l'écriture refuse ALCOHOL. Une
    // ligne ALCOHOL présente en base serait servie par GET /products,
    // /products/search et la carte vendeur.
    const where = JSON.stringify(
      catalogProductWhere({
        availableFrom: 'availableFrom',
        availableUntil: 'availableUntil',
      } as never),
    );
    expect(where).not.toContain('productType');
    expect(where).not.toContain('ALCOHOL');
  });
});
