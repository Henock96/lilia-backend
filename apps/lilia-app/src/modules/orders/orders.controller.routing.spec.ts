import 'reflect-metadata';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';

import { OrdersController } from './orders.controller';

/**
 * Ordre de déclaration des routes `GET /orders/restaurant/*` (Lot 2, ADM-02).
 *
 * Express sert la **première** route qui correspond. `restaurant/:id`, déclaré
 * avant `restaurant/stuck` ou `restaurant/pending-count`, lirait « stuck » et
 * « pending-count » comme des identifiants : l'alerte des commandes bloquées
 * et le badge du vendeur répondraient « Commande introuvable ». Rien dans le
 * langage n'empêche de réordonner les méthodes ; ce test rend l'ordre exigible.
 */
describe('OrdersController — ordre des routes GET', () => {
  function getRoutePathsInOrder(): string[] {
    const proto = OrdersController.prototype as unknown as Record<
      string,
      unknown
    >;
    return Object.getOwnPropertyNames(proto)
      .filter((name) => name !== 'constructor')
      .filter(
        (name) =>
          Reflect.getMetadata(METHOD_METADATA, proto[name] as object) ===
          RequestMethod.GET,
      )
      .map(
        (name) =>
          Reflect.getMetadata(PATH_METADATA, proto[name] as object) as string,
      );
  }

  it('déclare `restaurant/:id` après les routes littérales `restaurant/*`', () => {
    const paths = getRoutePathsInOrder();
    const byId = paths.indexOf('restaurant/:id');

    expect(byId).toBeGreaterThanOrEqual(0);
    for (const literal of [
      'restaurant',
      'restaurant/stuck',
      'restaurant/pending-count',
    ]) {
      expect(paths.indexOf(literal)).toBeGreaterThanOrEqual(0);
      expect(paths.indexOf(literal)).toBeLessThan(byId);
    }
  });

  it('aucune route littérale n’est déclarée après `:id`', () => {
    const paths = getRoutePathsInOrder();
    const idIndex = paths.indexOf(':id');

    const shadowed = paths.slice(idIndex + 1).filter((p) => !p.includes(':'));
    expect(shadowed).toEqual([]);
  });
});
