import { ForbiddenException, NotFoundException } from '@nestjs/common';

import { RestaurantAccessService } from './restaurant-access.service';

/**
 * Arbitre de propriété du catalogue — `resolveTargetRestaurant`.
 *
 * Ce fichier existe parce que l'arbitre n'était testé qu'au travers de mocks :
 * chaque service appelant le remplaçait par un `jest.fn()`, si bien qu'aucun
 * test ne disait ce qu'il répond réellement. Or il refusait **tout**
 * `restaurantId` venu d'un non-ADMIN, y compris celui de la boutique de
 * l'appelant — et le back-office web comme l'app vendeurs envoient justement
 * cet identifiant pour LIRE leur catalogue (`GET /products/manage`,
 * `GET /categories`). Le vendeur recevait « Seul un administrateur peut écrire
 * dans le catalogue d'un autre vendeur » en ouvrant sa propre page Produits.
 *
 * Les colonnes reprennent celles de `restaurants.authorization.spec.ts` :
 * propriétaire / autre propriétaire / admin.
 */
describe('RestaurantAccessService.resolveTargetRestaurant', () => {
  const VENDORS = [
    { id: 'resto-a', vendorType: 'RESTAURANT', ownerUid: 'uid-a' },
    { id: 'resto-b', vendorType: 'BAKERY', ownerUid: 'uid-b' },
  ];
  const ROLES: Record<string, string> = {
    'uid-a': 'RESTAURATEUR',
    'uid-b': 'RESTAURATEUR',
    'uid-sans-boutique': 'RESTAURATEUR',
    'uid-admin': 'ADMIN',
  };

  type Where = { id?: string; owner?: { firebaseUid?: string } };
  const project = (v: (typeof VENDORS)[number]) => ({
    id: v.id,
    vendorType: v.vendorType,
  });

  /**
   * Petite table en mémoire qui applique réellement le `where` : un mock qui
   * rendrait la même ligne quelle que soit la requête ne vérifierait pas que la
   * propriété est contrôlée en base.
   */
  function build() {
    const prisma = {
      restaurant: {
        findFirst: jest.fn(({ where }: { where: Where }) => {
          const v = VENDORS.find(
            (r) =>
              (where.id === undefined || r.id === where.id) &&
              (where.owner?.firebaseUid === undefined ||
                r.ownerUid === where.owner.firebaseUid),
          );
          return Promise.resolve(v ? project(v) : null);
        }),
        findUnique: jest.fn(({ where }: { where: Where }) => {
          const v = VENDORS.find((r) => r.id === where.id);
          return Promise.resolve(v ? project(v) : null);
        }),
      },
      user: {
        findUnique: jest.fn(({ where }: { where: { firebaseUid: string } }) => {
          const role = ROLES[where.firebaseUid];
          return Promise.resolve(role ? { role } : null);
        }),
      },
    };
    return new RestaurantAccessService(prisma as never);
  }

  describe('propriétaire', () => {
    it('sans restaurantId, reçoit sa boutique', async () => {
      await expect(build().resolveTargetRestaurant('uid-a')).resolves.toEqual({
        id: 'resto-a',
        vendorType: 'RESTAURANT',
        onBehalfOf: false,
      });
    });

    it("en nommant sa propre boutique, la reçoit — ce n'est pas agir pour un tiers", async () => {
      await expect(
        build().resolveTargetRestaurant('uid-a', 'resto-a'),
      ).resolves.toEqual({
        id: 'resto-a',
        vendorType: 'RESTAURANT',
        onBehalfOf: false,
      });
    });

    it('sans boutique, est refusé', async () => {
      await expect(
        build().resolveTargetRestaurant('uid-sans-boutique'),
      ).rejects.toThrow(/posséder un vendeur/);
    });
  });

  describe('autre propriétaire', () => {
    it("en nommant la boutique d'un autre, est refusé", async () => {
      const call = build().resolveTargetRestaurant('uid-b', 'resto-a');
      await expect(call).rejects.toBeInstanceOf(ForbiddenException);
      await expect(call).rejects.toThrow(/Seul un administrateur/);
    });

    it("en nommant un identifiant inexistant, reçoit 403 et non 404 — l'arbitre ne dit pas quels vendeurs existent", async () => {
      await expect(
        build().resolveTargetRestaurant('uid-b', 'resto-inconnu'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('admin', () => {
    it('en nommant une boutique, la reçoit au nom du vendeur', async () => {
      await expect(
        build().resolveTargetRestaurant('uid-admin', 'resto-b'),
      ).resolves.toEqual({
        id: 'resto-b',
        vendorType: 'BAKERY',
        onBehalfOf: true,
      });
    });

    it('en nommant un identifiant inexistant, reçoit 404', async () => {
      await expect(
        build().resolveTargetRestaurant('uid-admin', 'resto-inconnu'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
