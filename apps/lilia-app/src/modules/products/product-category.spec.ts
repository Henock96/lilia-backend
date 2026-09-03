import { BadRequestException, NotFoundException } from '@nestjs/common';

import { ProductCommandService } from './product-command.service';

/**
 * Rattachement d'un produit à une section — et refus du cross-vendeur.
 *
 * La garantie dure est portée par la clé étrangère composite
 * `(categoryId, restaurantId)` et vérifiée sur un vrai PostgreSQL
 * (`test/integration/catalog-isolation.int-spec.ts`). Ces tests-ci vérifient
 * la **couche applicative** : qu'elle refuse tôt, et avec un message qui dit
 * quoi corriger — un P2003 brut n'apprend rien à un vendeur.
 */
describe('ProductCommandService — produit ↔ section', () => {
  const RESTO_A = 'resto-a';
  const RESTO_B = 'resto-b';

  function build(overrides: Record<string, unknown> = {}) {
    const prisma = {
      category: { findUnique: jest.fn() },
      product: { findUnique: jest.fn(), create: jest.fn(), update: jest.fn() },
      productVariant: { createMany: jest.fn() },
      user: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: 'u', role: 'RESTAURATEUR' }),
      },
      orderItem: { count: jest.fn().mockResolvedValue(0) },
      $transaction: jest.fn(async (fn: (tx: unknown) => unknown) =>
        fn({
          product: {
            create: jest.fn().mockResolvedValue({ id: 'p1' }),
            findUnique: jest.fn().mockResolvedValue({ id: 'p1', variants: [] }),
          },
          productVariant: { createMany: jest.fn() },
        }),
      ),
      ...overrides,
    };
    const validator = {
      assertProductTypeAllowed: jest.fn(),
      assertAvailabilityWindow: jest.fn(),
    };
    const access = {
      resolveTargetRestaurant: jest.fn().mockResolvedValue({
        id: RESTO_A,
        vendorType: 'RESTAURANT',
        onBehalfOf: false,
      }),
    };
    const audit = { record: jest.fn() };

    const service = new ProductCommandService(
      prisma as never,
      validator as never,
      access as never,
      audit as never,
    );
    return { service, prisma, access };
  }

  const baseDto = { nom: 'Coca', prixOriginal: 1000 };

  it('accepte une section du MÊME vendeur', async () => {
    const { service, prisma } = build();
    prisma.category.findUnique.mockResolvedValue({ restaurantId: RESTO_A });

    await expect(
      service.create({ ...baseDto, categoryId: 'cat-a' }, 'fb-a'),
    ).resolves.toMatchObject({ message: expect.any(String) });
  });

  it("refuse une section d'un AUTRE vendeur, avec un message actionnable", async () => {
    const { service, prisma } = build();
    prisma.category.findUnique.mockResolvedValue({ restaurantId: RESTO_B });

    await expect(
      service.create({ ...baseDto, categoryId: 'cat-b' }, 'fb-a'),
    ).rejects.toThrow(BadRequestException);
    await expect(
      service.create({ ...baseDto, categoryId: 'cat-b' }, 'fb-a'),
    ).rejects.toThrow(/autre vendeur/i);
  });

  it('404 si la section n’existe pas', async () => {
    const { service, prisma } = build();
    prisma.category.findUnique.mockResolvedValue(null);

    await expect(
      service.create({ ...baseDto, categoryId: 'fantome' }, 'fb-a'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('accepte un produit SANS section', async () => {
    // Une section est un confort d'organisation, pas une condition de vente :
    // la rendre obligatoire empêchait un vendeur neuf de mettre quoi que ce
    // soit en vente.
    const { service, prisma } = build();

    await expect(service.create(baseDto, 'fb-a')).resolves.toMatchObject({
      message: expect.any(String),
    });
    expect(prisma.category.findUnique).not.toHaveBeenCalled();
  });

  it('à la mise à jour, la section est comparée au vendeur DU PRODUIT', async () => {
    // Et non à celui de l'appelant : un ADMIN agit pour un tiers, comparer au
    // sien laisserait passer un rattachement croisé.
    const { service, prisma } = build();
    prisma.product.findUnique.mockResolvedValue({
      id: 'p1',
      restaurantId: RESTO_B,
      productType: 'FOOD',
      availableFrom: null,
      availableUntil: null,
      restaurant: { vendorType: 'RESTAURANT', owner: { firebaseUid: 'fb-b' } },
    });
    prisma.user.findUnique.mockResolvedValue({ id: 'admin', role: 'ADMIN' });
    prisma.category.findUnique.mockResolvedValue({ restaurantId: RESTO_A });

    await expect(
      service.update('p1', { categoryId: 'cat-a' }, 'fb-admin'),
    ).rejects.toThrow(/autre vendeur/i);
  });

  it("le vendeur cible d'une création vient du résolveur, pas du corps", async () => {
    const { service, access } = build();
    await service.create({ ...baseDto, restaurantId: 'resto-usurpe' }, 'fb-a');
    // Le service ne lit jamais `dto.restaurantId` : il le transmet au résolveur,
    // qui refuse (403) si l'appelant n'est pas ADMIN.
    expect(access.resolveTargetRestaurant).toHaveBeenCalledWith(
      'fb-a',
      'resto-usurpe',
    );
  });
});
