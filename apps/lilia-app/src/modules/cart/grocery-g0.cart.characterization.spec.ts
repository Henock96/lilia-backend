import { CartItemsService } from './cart-items.service';

/**
 * G0 — R-05 / R-06 / R-07 côté panier : ce que `addItem` contrôle, et ce
 * qu'il ne contrôle pas. Comportement **actuel**.
 *
 * Le panier vérifie l'état du PRODUIT (retiré, indisponible, hors créneau,
 * stock). Il ne lit pas le VENDEUR : la frontière de visibilité
 * (`PUBLIC_VENDOR_WHERE`) n'est réappliquée qu'au checkout
 * (`OrderValidatorService.validateRestaurantOpen`, couvert par
 * `vendors/grocery-g0.vendor.characterization.spec.ts`).
 */
const SETTINGS = {
  getSettings: jest.fn().mockResolvedValue({ modifiersEnabled: false }),
};

function build(product: Record<string, unknown>) {
  const create = jest.fn().mockResolvedValue({});
  const findUnique = jest.fn().mockResolvedValue({
    id: 'v1',
    productId: 'p1',
    prix: 2500,
    stockConsumption: 1,
    product: {
      id: 'p1',
      nom: 'Couches T3 x30',
      restaurantId: 'g1',
      madeToOrder: false,
      isAvailable: true,
      deletedAt: null,
      availableFrom: null,
      availableUntil: null,
      stockRestant: 10,
      modifierGroups: [],
      ...product,
    },
  });
  const prisma = {
    productVariant: { findUnique },
    cartItem: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      update: jest.fn(),
      create,
    },
  };
  const common = {
    getUserOrThrow: jest.fn().mockResolvedValue({ id: 'u1' }),
    getOrCreateCart: jest.fn().mockResolvedValue({ id: 'c1' }),
    getCart: jest.fn().mockResolvedValue({ items: [] }),
    assertSameRestaurant: jest.fn(),
    assertSameMadeToOrderMode: jest.fn(),
  };
  const service = new CartItemsService(
    prisma as never,
    common as never,
    SETTINGS as never,
  );
  return { service, findUnique, create };
}

describe('G0 — panier : ce que addItem contrôle', () => {
  it('[ACTUEL] la lecture de la variante ne charge pas le vendeur : aucune frontière de visibilité au panier', async () => {
    const { service, findUnique, create } = build({});
    await service.addItem('fb', { variantId: 'v1', quantite: 1 } as never);

    const include = findUnique.mock.calls[0][0].include;
    expect(Object.keys(include.product.include)).toEqual(['modifierGroups']);
    // Un produit d'un vendeur DRAFT / non approuvé / suspendu entre donc au
    // panier si son identifiant de variante est connu ; il est refusé au
    // checkout (« n'est plus disponible sur la plateforme »).
    expect(create).toHaveBeenCalled();
  });

  it('[ACTUEL] productType n’est pas relu au panier : une ligne ALCOHOL existante entrerait', async () => {
    const { service, create } = build({ productType: 'ALCOHOL' });
    await service.addItem('fb', { variantId: 'v1', quantite: 1 } as never);
    expect(create).toHaveBeenCalled();
  });

  it('produit d’épicerie désactivé : refusé au panier', async () => {
    const { service, create } = build({ isAvailable: false });
    await expect(
      service.addItem('fb', { variantId: 'v1', quantite: 1 } as never),
    ).rejects.toThrow(/indisponible/);
    expect(create).not.toHaveBeenCalled();
  });

  it('produit d’épicerie retiré (deletedAt) : refusé au panier', async () => {
    const { service } = build({ deletedAt: new Date('2026-10-01') });
    await expect(
      service.addItem('fb', { variantId: 'v1', quantite: 1 } as never),
    ).rejects.toThrow(/n'est plus proposé/);
  });

  it('stock réel insuffisant : refus codé OUT_OF_STOCK', async () => {
    const { service } = build({ stockRestant: 2, stockPolicy: 'INVENTORY' });
    const error = await service
      .addItem('fb', { variantId: 'v1', quantite: 3 } as never)
      .then(
        () => null,
        (e: { getResponse: () => unknown }) => e.getResponse(),
      );
    expect(error).toMatchObject({ code: 'OUT_OF_STOCK' });
  });
});
