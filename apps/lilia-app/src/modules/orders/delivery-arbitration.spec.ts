import { OrderStatus } from '@prisma/client';

import { deliveryArbitrable } from './delivery-arbitration';
import { withAllowedActions } from './order-allowed-actions';

/**
 * Le bouton « Clôturer la livraison » suit un verdict serveur : ADMIN, une
 * livraison, prête ou en route. Rien d'autre.
 */
describe('deliveryArbitrable', () => {
  const statuses = Object.values(OrderStatus);

  it('ADMIN, livraison PRET ou EN_ROUTE : seuls cas publiés', () => {
    const published = statuses.filter((status) =>
      deliveryArbitrable({ status, isDelivery: true }, 'ADMIN'),
    );
    expect(published.sort()).toEqual(['EN_ROUTE', 'PRET']);
  });

  it('un retrait ne se clôture pas ici (il a son propre arbitrage)', () => {
    for (const status of statuses) {
      expect(deliveryArbitrable({ status, isDelivery: false }, 'ADMIN')).toBe(
        false,
      );
    }
  });

  it('aucun autre rôle ne le voit', () => {
    for (const role of ['CLIENT', 'RESTAURATEUR', 'LIVREUR']) {
      expect(
        deliveryArbitrable({ status: 'PRET', isDelivery: true }, role),
      ).toBe(false);
    }
  });

  it('publié avec la commande, à côté de allowedActions (inchangé)', () => {
    const [order] = withAllowedActions(
      [{ status: 'EN_ROUTE' as OrderStatus, isDelivery: true }],
      'ADMIN',
      { acceptanceRequired: false },
    );
    expect(order.deliveryArbitrable).toBe(true);
    expect(order.allowedActions).not.toContain('ARBITRATE_DELIVERY');
  });
});
