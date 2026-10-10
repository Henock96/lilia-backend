import { VendorType } from '@prisma/client';

import { CartCommonService } from './cart-common.service';

/**
 * D-4 — `GET /cart` annonce le taux de frais de service **de la boutique du
 * panier** (`serviceFeePercent`), calculé par le serveur : les clients
 * l'affichent dans leur estimation au lieu du taux général, et ne recopient
 * pas la règle « épicerie = taux propre » (règle 2).
 *
 * `toCartView` est isolé : ce test porte sur le taux qu'on lui transmet.
 */
jest.mock('./cart-view', () => ({
  ...jest.requireActual('./cart-view'),
  toCartView: jest.fn(
    (cart: { items: unknown[] }, _modifiers: boolean, rate: number | null) => ({
      items: cart.items,
      serviceFeePercent: rate,
    }),
  ),
}));

describe('GET /cart — taux de frais de service de la boutique (D-4)', () => {
  function build(opts: {
    items: { product: { restaurantId: string } }[];
    vendorType?: VendorType;
    groceryServiceFeeBps: number | null;
  }) {
    const prisma = {
      user: { findUnique: jest.fn().mockResolvedValue({ id: 'u1' }) },
      cart: {
        findUnique: jest
          .fn()
          .mockResolvedValueOnce({ id: 'c1', userId: 'u1' })
          .mockResolvedValueOnce({ id: 'c1', items: opts.items }),
      },
      restaurant: {
        findUnique: jest
          .fn()
          .mockResolvedValue(
            opts.vendorType ? { vendorType: opts.vendorType } : null,
          ),
      },
    };
    const settings = {
      getSettings: jest.fn().mockResolvedValue({
        modifiersEnabled: false,
        serviceFeePercent: 15,
        groceryServiceFeeBps: opts.groceryServiceFeeBps,
      }),
    };
    return {
      service: new CartCommonService(prisma as never, settings as never),
      prisma,
    };
  }

  const line = (restaurantId: string) => ({ product: { restaurantId } });

  it('panier d’une épicerie, taux épicerie à 5 % : 5', async () => {
    const { service, prisma } = build({
      items: [line('g1')],
      vendorType: VendorType.GROCERY,
      groceryServiceFeeBps: 500,
    });
    const cart = (await service.getCart('fb')) as unknown as {
      serviceFeePercent: number | null;
    };
    expect(cart.serviceFeePercent).toBe(5);
    expect(prisma.restaurant.findUnique).toHaveBeenCalledWith({
      where: { id: 'g1' },
      select: { vendorType: true },
    });
  });

  it('panier d’un restaurant : le taux général (15)', async () => {
    const { service } = build({
      items: [line('r1')],
      vendorType: VendorType.RESTAURANT,
      groceryServiceFeeBps: 500,
    });
    const cart = (await service.getCart('fb')) as unknown as {
      serviceFeePercent: number | null;
    };
    expect(cart.serviceFeePercent).toBe(15);
  });

  it('épicerie, taux épicerie non posé : le taux général (15)', async () => {
    const { service } = build({
      items: [line('g1')],
      vendorType: VendorType.GROCERY,
      groceryServiceFeeBps: null,
    });
    const cart = (await service.getCart('fb')) as unknown as {
      serviceFeePercent: number | null;
    };
    expect(cart.serviceFeePercent).toBe(15);
  });

  it('panier vide : aucun taux annoncé, aucune requête vendeur', async () => {
    const { service, prisma } = build({
      items: [],
      groceryServiceFeeBps: 500,
    });
    const cart = (await service.getCart('fb')) as unknown as {
      serviceFeePercent: number | null;
    };
    expect(cart.serviceFeePercent).toBeNull();
    expect(prisma.restaurant.findUnique).not.toHaveBeenCalled();
  });
});
