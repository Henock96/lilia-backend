import { BadRequestException } from '@nestjs/common';

import { CartItemsService } from './cart-items.service';

/**
 * Le panier connaît le stock (fix S-2, audit du 05/09/2026).
 *
 * `addItem` ne vérifiait que `unavailabilityReason`, qui ignorait le stock, et
 * `updateItemQuantity` ne vérifiait **rien**. On pouvait donc ajouter au panier
 * un produit épuisé, et porter à 50 la quantité d'un produit dont il restait
 * une unité : `POST /cart/items` et `PATCH /cart/items/:id` répondaient 200.
 * Le refus n'arrivait qu'au `POST /orders/checkout`, après la saisie de
 * l'adresse et du moyen de paiement — c'est-à-dire au pire moment du tunnel.
 *
 * ⚠️ Ce contrôle est **consultatif**. Entre cette lecture et le checkout, une
 * autre transaction peut prendre la dernière unité ; c'est la décrémentation
 * atomique (`WHERE stockRestant >= qty`) qui arbitre, et elle reste seule
 * garante. Ces tests vérifient qu'on cesse de laisser un client remplir un
 * panier impayable, pas qu'on a déplacé la source de vérité.
 */
describe('Panier — contrôle de stock', () => {
  const PRODUCT = {
    id: 'p1',
    nom: 'Poulet braisé',
    restaurantId: 'r1',
    madeToOrder: false,
    isAvailable: true,
    deletedAt: null,
    availableFrom: null,
    availableUntil: null,
    stockRestant: 3,
  };

  function build({
    stockRestant = 3,
    cartItems = [] as { productId: string; quantite: number }[],
  } = {}) {
    const product = { ...PRODUCT, stockRestant };
    const update = jest.fn().mockResolvedValue({});
    const create = jest.fn().mockResolvedValue({});

    const prisma = {
      productVariant: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'v1',
          productId: 'p1',
          prix: 3000,
          product,
        }),
      },
      cartItem: {
        findMany: jest.fn().mockResolvedValue(cartItems),
        findFirst: jest.fn().mockResolvedValue(null),
        update,
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

    return {
      service: new CartItemsService(prisma as never, common as never),
      prisma,
      create,
      update,
    };
  }

  describe('addItem', () => {
    it('accepte une quantité disponible', async () => {
      const { service, create } = build({ stockRestant: 3 });

      await service.addItem('fb', { variantId: 'v1', quantite: 2 } as never);

      expect(create).toHaveBeenCalled();
    });

    it('refuse un produit épuisé', async () => {
      const { service, create } = build({ stockRestant: 0 });

      await expect(
        service.addItem('fb', { variantId: 'v1', quantite: 1 } as never),
      ).rejects.toThrow(/épuisé/i);
      expect(create).not.toHaveBeenCalled();
    });

    it('refuse une quantité supérieure au stock', async () => {
      const { service } = build({ stockRestant: 3 });

      await expect(
        service.addItem('fb', { variantId: 'v1', quantite: 5 } as never),
      ).rejects.toThrow(/il ne reste que 3/i);
    });

    it('compte ce qui est DÉJÀ au panier, pas seulement l’incrément', async () => {
      // Ajouter 1 unité dix fois de suite est le geste ordinaire d'un client
      // sur mobile. Ne valider que l'incrément laisserait passer n'importe
      // quel total, un ajout à la fois.
      const { service } = build({
        stockRestant: 3,
        cartItems: [{ productId: 'p1', quantite: 3 }],
      });

      await expect(
        service.addItem('fb', { variantId: 'v1', quantite: 1 } as never),
      ).rejects.toThrow(/il ne reste que 3/i);
    });

    it('agrège les variantes du même produit', async () => {
      // Le stock est porté par le produit, pas par la variante
      // (`ProductVariant` n'a aucune colonne de stock) : deux variantes du même
      // plat puisent dans le même compteur. La décrémentation du checkout le
      // savait déjà, le panier l'ignorait.
      const { service } = build({
        stockRestant: 3,
        cartItems: [
          { productId: 'p1', quantite: 2 }, // variante « Normal »
          { productId: 'p1', quantite: 1 }, // variante « Grand »
        ],
      });

      await expect(
        service.addItem('fb', { variantId: 'v1', quantite: 1 } as never),
      ).rejects.toThrow(BadRequestException);
    });

    it('laisse passer un produit à stock illimité', async () => {
      const { service, create } = build({
        stockRestant: null as unknown as number,
      });

      await service.addItem('fb', { variantId: 'v1', quantite: 42 } as never);

      expect(create).toHaveBeenCalled();
    });
  });

  describe('updateItemQuantity', () => {
    function buildUpdate({
      stockRestant = 3,
      siblings = [] as { quantite: number }[],
    } = {}) {
      const update = jest.fn().mockResolvedValue({});
      const prisma = {
        cartItem: {
          findFirst: jest.fn().mockResolvedValue({
            id: 'ci1',
            cartId: 'c1',
            productId: 'p1',
            menuId: null,
            quantite: 1,
            product: { ...PRODUCT, stockRestant },
          }),
          findMany: jest.fn().mockResolvedValue(siblings),
          update,
        },
      };
      const common = {
        getUserOrThrow: jest.fn().mockResolvedValue({ id: 'u1' }),
        getCart: jest.fn().mockResolvedValue({ items: [] }),
      };
      return {
        service: new CartItemsService(prisma as never, common as never),
        update,
      };
    }

    it('accepte une quantité disponible', async () => {
      const { service, update } = buildUpdate({ stockRestant: 5 });

      await service.updateItemQuantity('fb', 'ci1', { quantite: 4 } as never);

      expect(update).toHaveBeenCalled();
    });

    it('refuse de dépasser le stock', async () => {
      const { service, update } = buildUpdate({ stockRestant: 1 });

      await expect(
        service.updateItemQuantity('fb', 'ci1', { quantite: 50 } as never),
      ).rejects.toThrow(/il ne reste que 1/i);
      expect(update).not.toHaveBeenCalled();
    });

    it('compte les autres lignes du même produit', async () => {
      const { service } = buildUpdate({
        stockRestant: 4,
        siblings: [{ quantite: 3 }],
      });

      await expect(
        service.updateItemQuantity('fb', 'ci1', { quantite: 2 } as never),
      ).rejects.toThrow(/il ne reste que 4/i);
    });

    it('refuse un produit devenu indisponible depuis l’ajout', async () => {
      const { service } = buildUpdate({ stockRestant: 0 });

      await expect(
        service.updateItemQuantity('fb', 'ci1', { quantite: 1 } as never),
      ).rejects.toThrow(/épuisé/i);
    });
  });
});
