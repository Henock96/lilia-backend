import { CatalogRevalidationService } from './catalog-revalidation.service';
import { CatalogCacheListener } from './catalog-cache.listener';
import { CatalogChangedEvent } from '../events/catalog-events';

/**
 * Invalidation du cache du site public après une écriture au catalogue.
 *
 * ## Ce qui est vraiment en jeu
 *
 * Cet appel part depuis un **chemin d'écriture** : enregistrer un produit, une
 * section, un menu. La propriété qui compte n'est donc pas « le site a bien été
 * prévenu » — c'est **« l'écriture n'en dépend jamais »**. Un site injoignable,
 * lent ou en cours de déploiement ne doit ni retarder ni faire échouer la
 * sauvegarde du vendeur.
 *
 * Le repli est déjà là et suffit : `cacheLife('minutes')` côté web borne la
 * péremption. Une invalidation perdue coûte quelques minutes de retard, pas une
 * incohérence durable — c'est précisément pourquoi on n'a pas mis cet appel
 * dans l'outbox, qui existe pour ce qui doit être garanti.
 */
describe('CatalogRevalidationService', () => {
  const URL = 'https://liliafood.com/api/revalidate';
  const SECRET = 'un-secret-assez-long-pour-passer';

  const config = (values: Record<string, string | undefined>) =>
    ({ get: (k: string) => values[k] }) as never;

  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    global.fetch = fetchMock as never;
  });

  describe('configuré', () => {
    const service = () =>
      new CatalogRevalidationService(
        config({ WEB_REVALIDATE_URL: URL, WEB_REVALIDATE_SECRET: SECRET }),
      );

    it('poste l’identifiant du vendeur avec le secret partagé', async () => {
      service().revalidateVendor('v1', 'product.updated');
      await flush();

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(URL);
      expect(init.method).toBe('POST');
      expect(
        (init.headers as Record<string, string>)['x-revalidate-secret'],
      ).toBe(SECRET);
      expect(JSON.parse(init.body as string)).toEqual({
        restaurantId: 'v1',
        reason: 'product.updated',
      });
    });

    it('borne l’appel dans le temps — un site lent ne retient pas le backend', () => {
      service().revalidateVendor('v1', 'product.updated');

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(init.signal).toBeDefined();
    });

    it('ne rend rien et n’attend rien : l’écriture ne dépend pas du site', () => {
      // Un `fetch` qui ne se résout jamais ne doit pas bloquer l'appelant.
      fetchMock.mockReturnValue(new Promise(() => {}));

      expect(service().revalidateVendor('v1', 'x')).toBeUndefined();
    });

    it('avale un échec réseau — sauvegarder un produit reste possible', async () => {
      fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));

      expect(() => service().revalidateVendor('v1', 'x')).not.toThrow();
      await flush();
    });

    it('avale un refus du site (401, 500…)', async () => {
      fetchMock.mockResolvedValue({ ok: false, status: 401 });

      expect(() => service().revalidateVendor('v1', 'x')).not.toThrow();
      await flush();
    });
  });

  describe('non configuré — mode dégradé assumé', () => {
    it.each([
      ['aucune variable', {}],
      ['URL seule', { WEB_REVALIDATE_URL: URL }],
      ['secret seul', { WEB_REVALIDATE_SECRET: SECRET }],
    ])('%s → aucun appel', (_titre, values) => {
      // Les deux variables sont solidaires : poster sans secret ferait de la
      // route du site une purge ouverte à tous.
      new CatalogRevalidationService(config(values)).revalidateVendor(
        'v1',
        'x',
      );

      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('CatalogCacheListener', () => {
    it('relaie l’événement au service, et rien d’autre', () => {
      const revalidation = { revalidateVendor: jest.fn() };
      const listener = new CatalogCacheListener(revalidation as never);

      listener.handleCatalogChanged(
        new CatalogChangedEvent('v1', 'category.reordered'),
      );

      expect(revalidation.revalidateVendor).toHaveBeenCalledWith(
        'v1',
        'category.reordered',
      );
    });
  });

  /** Laisse la micro-tâche du `fetch` s'exécuter. */
  const flush = () => new Promise((r) => setImmediate(r));
});
