import 'reflect-metadata';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';

import { ProductsController } from './products.controller';

/**
 * Ordre de déclaration des routes `GET /products/*`.
 *
 * Express sert la **première** route qui correspond. Un `@Get(':id')` déclaré
 * avant `@Get('manage')` capture donc `/products/manage` et le traite comme un
 * identifiant : la réponse n'est pas une erreur de routage lisible mais un
 * `404 Produit avec l'ID "manage" non trouvé` — un message qui envoie chercher
 * le défaut au mauvais endroit.
 *
 * Rien dans le langage n'empêche de réordonner les méthodes d'une classe. Ce
 * test rend l'ordre exigible.
 */
describe('ProductsController — ordre des routes GET', () => {
  function getRoutePathsInOrder(): string[] {
    const proto = ProductsController.prototype as unknown as Record<
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

  it('déclare toutes les routes littérales avant la route paramétrée `:id`', () => {
    const paths = getRoutePathsInOrder();
    const idIndex = paths.indexOf(':id');

    expect(idIndex).toBeGreaterThanOrEqual(0);

    const shadowed = paths
      .slice(idIndex + 1)
      .filter((p) => p !== ':id' && !p.includes(':'));

    expect(shadowed).toEqual([]);
  });

  it('sert `manage` avant `:id`', () => {
    const paths = getRoutePathsInOrder();
    expect(paths.indexOf('manage')).toBeGreaterThanOrEqual(0);
    expect(paths.indexOf('manage')).toBeLessThan(paths.indexOf(':id'));
  });
});
