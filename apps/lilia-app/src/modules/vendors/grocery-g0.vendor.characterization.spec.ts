import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { OnboardingStatus, VendorType } from '@prisma/client';

import { PUBLIC_VENDOR_WHERE } from '../../common/vendor-visibility';
import { AdminRestaurantsService } from '../admin/admin-restaurants.service';
import { AdminVendorFilterDto } from '../admin/dto/admin-vendor-filter.dto';
import { CreateRestaurantWithOwnerDto } from '../admin/dto/create-restaurant-with-owner.dto';
import { CartCommonService } from '../cart/cart-common.service';
import { DEFAULT_CATEGORIES_BY_VENDOR_TYPE } from '../categories/category.includes';
import { OrderValidatorService } from '../orders/order-validator.service';
import { CreateProductDto } from '../products/dto/create-product.dto';
import { ProductFilterQueryDto } from '../products/dto/product-query.dto';
import { CreateVendorDto } from './dto/create-vendor.dto';
import { FilterVendorsDto } from './dto/filter-vendors.dto';
import { CreateVendorOnboardingDto } from './dto/onboarding.dto';
import { VendorOnboardingService } from './vendor-onboarding.service';
import { VendorsService } from './vendors.service';

/**
 * G0 — caractérisation du cycle de vie d'un vendeur GROCERY, avant
 * l'extension aux épiceries. Comportement **actuel**, pas voulu : les titres
 * « [ACTUEL] » marquent un comportement à faire évoluer plus tard.
 */

// ─── R-03 — création ─────────────────────────────────────────────────────────

describe('G0 — R-03 sections par défaut', () => {
  it('GROCERY naît avec « Épicerie » et « Boissons », et rien d’autre', () => {
    expect(DEFAULT_CATEGORIES_BY_VENDOR_TYPE.GROCERY).toEqual([
      'Épicerie',
      'Boissons',
    ]);
  });

  it('chaque type de vendeur a au moins une section par défaut', () => {
    for (const type of Object.values(VendorType)) {
      expect(DEFAULT_CATEGORIES_BY_VENDOR_TYPE[type].length).toBeGreaterThan(0);
    }
  });
});

describe('G0 — R-03 chemin 1 : POST /vendors (VendorsService.createVendor)', () => {
  function build() {
    const tx = {
      restaurant: {
        create: jest.fn(async ({ data }: { data: Record<string, any> }) => ({
          id: 'v1',
          nom: data.nom,
          vendorType: data.vendorType,
          adminApproved: data.adminApproved,
        })),
      },
    };
    const prisma = {
      user: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: 'owner', restaurant: null }),
      },
      $transaction: jest.fn(async (fn: (t: unknown) => unknown) => fn(tx)),
    };
    const service = new VendorsService(
      prisma as never,
      {} as never,
      { emit: jest.fn() } as never,
      { record: jest.fn() } as never,
      {} as never,
    );
    return { service, tx };
  }

  const dto = {
    vendorType: VendorType.GROCERY,
    ownerId: 'owner',
    nom: 'Supérette Moungali',
    adresse: 'Moungali',
    phone: '060000000',
  };

  it('GROCERY : adminApproved = false, sections GROCERY, aucun onboardingStatus posé (défaut base)', async () => {
    const { service, tx } = build();
    await service.createVendor(dto as never, 'admin-1');
    const data = tx.restaurant.create.mock.calls[0][0].data;
    expect(data.vendorType).toBe(VendorType.GROCERY);
    expect(data.adminApproved).toBe(false);
    expect(data.adminApprovedAt).toBeNull();
    expect(data.categories.create.map((c: { nom: string }) => c.nom)).toEqual([
      'Épicerie',
      'Boissons',
    ]);
    // `onboardingStatus` n'est pas écrit : c'est le défaut de la base (DRAFT) qui
    // s'applique — prouvé sur PostgreSQL par grocery-g0.int-spec.ts.
    expect(data).not.toHaveProperty('onboardingStatus');
  });

  it('RESTAURANT : auto-approuvé (référence)', async () => {
    const { service, tx } = build();
    await service.createVendor(
      { ...dto, vendorType: VendorType.RESTAURANT } as never,
      'admin-1',
    );
    expect(tx.restaurant.create.mock.calls[0][0].data.adminApproved).toBe(true);
  });
});

describe('G0 — R-03 chemin 2 : POST /admin/vendors (VendorOnboardingService.createVendor)', () => {
  function build() {
    const tx = {
      user: { create: jest.fn().mockResolvedValue({ id: 'u1' }) },
      restaurant: {
        create: jest.fn().mockResolvedValue({
          id: 'r1',
          nom: 'Supérette',
          vendorType: VendorType.GROCERY,
        }),
      },
    };
    const prisma = {
      user: { findUnique: jest.fn().mockResolvedValue(null) },
      $transaction: jest.fn((cb: (t: unknown) => unknown) => cb(tx)),
    };
    const service = new VendorOnboardingService(
      prisma as never,
      { createUser: jest.fn().mockResolvedValue('fb-1') } as never,
      { getReport: jest.fn().mockResolvedValue(null) } as never,
      {
        runOnce: jest.fn((_s: string, _k: unknown, op: () => unknown) => op()),
      } as never,
      { enqueueInTransaction: jest.fn().mockResolvedValue('o1') } as never,
      { record: jest.fn() } as never,
      {} as never,
      { emit: jest.fn() } as never,
    );
    jest.spyOn(service['logger'], 'log').mockImplementation(() => undefined);
    return { service, tx };
  }

  it('GROCERY : DRAFT, fermé, adminApproved = false, sections GROCERY', async () => {
    const { service, tx } = build();
    await service.createVendor(
      {
        vendorType: VendorType.GROCERY,
        ownerEmail: 'gerant@superette.cg',
        ownerNom: 'Gérant',
        ownerPhone: '060000001',
        nom: 'Supérette',
        adresse: 'Poto-Poto',
        phone: '060000002',
      } as never,
      'admin-1',
    );
    const data = tx.restaurant.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      vendorType: VendorType.GROCERY,
      onboardingStatus: OnboardingStatus.DRAFT,
      isOpen: false,
      adminApproved: false,
      adminApprovedAt: null,
      adminApprovedById: null,
    });
    expect(data.categories.create.map((c: { nom: string }) => c.nom)).toEqual([
      'Épicerie',
      'Boissons',
    ]);
  });
});

describe('G0 — R-03 chemin 3 : POST /admin/restaurants (AdminRestaurantsService)', () => {
  // Route dépréciée : les deux formulaires de création passent par le
  // chemin 2 (`POST /admin/vendors`). Les fonctions client qui l'appellent
  // existent encore (`admin_service.dart`, `useCreateRestaurantWithOwner`)
  // mais ne sont appelées par aucun écran — constaté le 10/10/2026.
  function build() {
    const tx = {
      user: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest
          .fn()
          .mockResolvedValue({ id: 'owner', role: 'RESTAURATEUR' }),
      },
      restaurant: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'r1' }),
      },
    };
    const prisma = {
      $transaction: jest.fn(async (fn: (t: unknown) => unknown) => fn(tx)),
    };
    const firebase = {
      createUser: jest.fn().mockResolvedValue('fb-1'),
      deleteUserSafe: jest.fn(),
    };
    const service = new AdminRestaurantsService(
      prisma as never,
      firebase as never,
    );
    jest.spyOn(service['logger'], 'log').mockImplementation(() => undefined);
    return { service, tx };
  }

  const base = {
    email: 'gerant@superette.cg',
    password: 'motdepasse',
    nom: 'Gérant',
    restaurantNom: 'Supérette',
    restaurantAdresse: 'Bacongo',
    restaurantPhone: '060000003',
  };

  it('GROCERY : accepté par le serveur, adminApproved = false, message « en attente de validation »', async () => {
    const { service, tx } = build();
    const res = await service.createRestaurantWithOwner({
      ...base,
      vendorType: VendorType.GROCERY,
    } as never);
    const data = tx.restaurant.create.mock.calls[0][0].data;
    expect(data.vendorType).toBe(VendorType.GROCERY);
    expect(data.adminApproved).toBe(false);
    expect(data).not.toHaveProperty('onboardingStatus');
    expect(data.categories.create.map((c: { nom: string }) => c.nom)).toEqual([
      'Épicerie',
      'Boissons',
    ]);
    expect(res.message).toBe('GROCERY créé — en attente de validation');
  });

  it('sans vendorType : RESTAURANT auto-approuvé (compatibilité historique)', async () => {
    const { service, tx } = build();
    await service.createRestaurantWithOwner(base as never);
    const data = tx.restaurant.create.mock.calls[0][0].data;
    expect(data.vendorType).toBe(VendorType.RESTAURANT);
    expect(data.adminApproved).toBe(true);
  });
});

// ─── R-05 — frontière de visibilité ───────────────────────────────────────────

describe('G0 — R-05 frontière de visibilité publique', () => {
  it('PUBLIC_VENDOR_WHERE exige ACTIVATED + adminApproved + isActive, sans condition de type', () => {
    expect(PUBLIC_VENDOR_WHERE).toEqual({
      onboardingStatus: OnboardingStatus.ACTIVATED,
      adminApproved: true,
      isActive: true,
    });
    expect(PUBLIC_VENDOR_WHERE).not.toHaveProperty('vendorType');
  });

  describe('checkout : OrderValidatorService.validateRestaurantOpen', () => {
    function build(vendor: Record<string, unknown>) {
      const prisma = {
        restaurant: { findUnique: jest.fn().mockResolvedValue(vendor) },
      };
      const opening = { decide: jest.fn().mockResolvedValue({ open: true }) };
      const validator = new OrderValidatorService(
        prisma as never,
        {} as never, // PromoService — non sollicité ici
        opening as never,
      );
      return validator;
    }
    const grocery = {
      id: 'g1',
      nom: 'Supérette',
      vendorType: VendorType.GROCERY,
      isActive: true,
      adminApproved: true,
      onboardingStatus: OnboardingStatus.ACTIVATED,
    };

    it('GROCERY publié et ouvert : accepté', async () => {
      await expect(
        build(grocery).validateRestaurantOpen('g1'),
      ).resolves.toMatchObject({ id: 'g1' });
    });

    it.each([
      ['non approuvé', { adminApproved: false }],
      ['suspendu', { isActive: false }],
      ['DRAFT', { onboardingStatus: OnboardingStatus.DRAFT }],
      ['READY', { onboardingStatus: OnboardingStatus.READY }],
    ])('GROCERY %s : 400 « n’est plus disponible »', async (_label, patch) => {
      await expect(
        build({ ...grocery, ...patch }).validateRestaurantOpen('g1'),
      ).rejects.toThrow(/n'est plus disponible/);
    });
  });
});

// ─── R-08 — un panier, un vendeur ─────────────────────────────────────────────

describe('G0 — R-08 panier mono-vendeur (CartCommonService.assertSameRestaurant)', () => {
  const common = new CartCommonService({} as never, {} as never);
  const line = (restaurantId: string) => ({ product: { restaurantId } });

  it('panier vide : tout vendeur accepté', () => {
    expect(() => common.assertSameRestaurant([], 'g1')).not.toThrow();
  });

  it('même vendeur GROCERY : accepté', () => {
    expect(() =>
      common.assertSameRestaurant([line('g1'), line('g1')], 'g1'),
    ).not.toThrow();
  });

  it('[ACTUEL] épicerie après restaurant : 400, message « restaurant » + « vider »', () => {
    let error: unknown;
    try {
      common.assertSameRestaurant([line('resto')], 'g1');
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(BadRequestException);
    const message = (error as Error).message;
    // Le site web détecte cette erreur par `includes('restaurant') ||
    // includes('vider')` (product-purchase.tsx, restaurant-menu.tsx) : ces
    // deux mots font partie du contrat de fait.
    expect(message).toContain('restaurant');
    expect(message).toContain('vider');
    // Aucun code machine : le client ne peut s'appuyer que sur le texte.
    expect((error as BadRequestException).getResponse()).not.toHaveProperty(
      'code',
    );
  });
});

// ─── R-10 — valeurs inconnues ─────────────────────────────────────────────────

describe('G0 — R-10 valeur inconnue de vendorType / productType → 400 de validation', () => {
  // Mêmes options que la ValidationPipe globale de `main.ts`.
  const pipe = new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: false,
    transform: true,
    transformOptions: { enableImplicitConversion: true },
  });

  const run = (
    metatype: new () => object,
    value: object,
    type: 'body' | 'query',
  ) => pipe.transform(value, { type, metatype });

  it.each([
    ['GET /vendors', FilterVendorsDto, { vendorType: 'SUPERMARKET' }, 'query'],
    [
      'GET /products',
      ProductFilterQueryDto,
      { vendorType: 'SUPERMARKET' },
      'query',
    ],
    [
      'GET /admin/vendors',
      AdminVendorFilterDto,
      { vendorType: 'SUPERMARKET' },
      'query',
    ],
    [
      'POST /vendors',
      CreateVendorDto,
      {
        vendorType: 'SUPERMARKET',
        ownerId: 'o',
        nom: 'n',
        adresse: 'a',
        phone: '060000000',
      },
      'body',
    ],
    [
      'POST /admin/restaurants',
      CreateRestaurantWithOwnerDto,
      {
        vendorType: 'SUPERMARKET',
        email: 'a@b.cg',
        password: 'motdepasse',
        restaurantNom: 'n',
        restaurantAdresse: 'a',
        restaurantPhone: '060000000',
      },
      'body',
    ],
    [
      'POST /admin/vendors',
      CreateVendorOnboardingDto,
      {
        vendorType: 'SUPERMARKET',
        ownerEmail: 'a@b.cg',
        ownerNom: 'n',
        ownerPhone: '060000000',
        nom: 'n',
        adresse: 'a',
        phone: '060000000',
      },
      'body',
    ],
  ] as const)(
    '%s : 400 sur vendorType',
    async (_route, metatype, value, type) => {
      const outcome = await run(metatype as never, value, type).then(
        () => null,
        (e: unknown) => e,
      );
      expect(outcome).toBeInstanceOf(BadRequestException);
      const messages = JSON.stringify(
        (outcome as BadRequestException).getResponse(),
      );
      expect(messages).toContain('vendorType');
    },
  );

  it('POST /products : productType inconnu → 400 sur productType', async () => {
    const outcome = await run(
      CreateProductDto,
      { nom: 'x', prixOriginal: 100, productType: 'SUPERMARKET' },
      'body',
    ).then(
      () => null,
      (e: unknown) => e,
    );
    expect(outcome).toBeInstanceOf(BadRequestException);
    expect(
      JSON.stringify((outcome as BadRequestException).getResponse()),
    ).toContain('productType');
  });

  it('POST /products : productType ALCOHOL passe la validation de DTO (le refus vient du service)', async () => {
    await expect(
      run(
        CreateProductDto,
        { nom: 'x', prixOriginal: 100, productType: 'ALCOHOL' },
        'body',
      ),
    ).resolves.toMatchObject({ productType: 'ALCOHOL' });
  });
});
