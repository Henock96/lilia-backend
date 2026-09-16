import {
  DEFAULT_COMMAND_TIMEOUT_MS,
  DEFAULT_CONNECT_TIMEOUT_MS,
  DEFAULT_THROTTLER_COMMAND_TIMEOUT_MS,
  buildRedisOptions,
} from './redis-options';

/**
 * Options ioredis par usage.
 *
 * Le défaut d'ioredis — `maxRetriesPerRequest: 20`, `enableOfflineQueue: true`,
 * **aucun `commandTimeout`** — ne fait pas échouer une commande quand Redis est
 * injoignable : il la met en attente. Sur le chemin d'un guard, cela ne dégrade
 * pas la plateforme, cela la gèle. Les replis (`UserCacheService` → Prisma,
 * `OrderCheckoutService` → sans garde + alerte) étaient déjà écrits ; il leur
 * manquait ce qui les déclenche.
 */
describe('buildRedisOptions', () => {
  const configOf = (values: Record<string, string>) => ({
    get: <T>(key: string) => values[key] as T,
  });

  it('pose un commandTimeout sur les trois usages — c’est le point du correctif', () => {
    for (const usage of ['business', 'throttler', 'tracking'] as const) {
      const options = buildRedisOptions({ usage });
      expect(options.commandTimeout).toBeGreaterThan(0);
      expect(options.connectTimeout).toBe(DEFAULT_CONNECT_TIMEOUT_MS);
    }
  });

  it('le throttler échoue plus vite que le client métier', () => {
    const business = buildRedisOptions({ usage: 'business' });
    const throttler = buildRedisOptions({ usage: 'throttler' });

    expect(business.commandTimeout).toBe(DEFAULT_COMMAND_TIMEOUT_MS);
    expect(throttler.commandTimeout).toBe(DEFAULT_THROTTLER_COMMAND_TIMEOUT_MS);
    // Le rate limiting est une protection : on peut s'en passer une seconde.
    // L'idempotence du checkout est une garantie : on l'attend un peu plus.
    expect(throttler.commandTimeout!).toBeLessThan(business.commandTimeout!);
  });

  it('le client métier réessaie une fois de plus que les autres', () => {
    expect(buildRedisOptions({ usage: 'business' }).maxRetriesPerRequest).toBe(
      2,
    );
    expect(buildRedisOptions({ usage: 'throttler' }).maxRetriesPerRequest).toBe(
      1,
    );
    expect(buildRedisOptions({ usage: 'tracking' }).maxRetriesPerRequest).toBe(
      1,
    );
  });

  it('laisse enableOfflineQueue à true, sur TOUS les usages', () => {
    // Le passer à `false` ferait échouer immédiatement toute commande émise
    // pendant une reconnexion — y compris la réservation d'idempotence du
    // checkout, pour une coupure d'une seconde. Ce serait dégrader une garantie
    // métier pour gagner de la latence. Le `commandTimeout` borne déjà
    // l'attente, sans ce prix-là.
    for (const usage of ['business', 'throttler', 'tracking'] as const) {
      expect(buildRedisOptions({ usage }).enableOfflineQueue).toBe(true);
    }
  });

  it('accepte une surcharge par variable d’environnement', () => {
    const config = configOf({
      REDIS_COMMAND_TIMEOUT_MS: '2500',
      REDIS_THROTTLER_COMMAND_TIMEOUT_MS: '300',
      REDIS_CONNECT_TIMEOUT_MS: '8000',
    });

    expect(
      buildRedisOptions({ usage: 'business', config }).commandTimeout,
    ).toBe(2500);
    expect(
      buildRedisOptions({ usage: 'throttler', config }).commandTimeout,
    ).toBe(300);
    expect(
      buildRedisOptions({ usage: 'tracking', config }).connectTimeout,
    ).toBe(8000);
  });

  it('ignore une valeur invalide plutôt que de produire un timeout de 0 ou NaN', () => {
    // `0` ferait échouer *toutes* les commandes ; `NaN` est interprété par
    // ioredis comme « pas de limite », c'est-à-dire exactement le défaut qu'on
    // corrige. Une faute de frappe dans une variable d'environnement ne doit
    // provoquer ni l'un ni l'autre.
    for (const bad of ['0', '-1', 'abc', '']) {
      const config = configOf({ REDIS_COMMAND_TIMEOUT_MS: bad });
      expect(
        buildRedisOptions({ usage: 'business', config }).commandTimeout,
      ).toBe(DEFAULT_COMMAND_TIMEOUT_MS);
    }
  });
});
