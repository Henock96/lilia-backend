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

  /**
   * **Un plafond posé sous la latence nominale ne protège pas, il coupe.**
   *
   * Le premier réglage livré — 500 ms pour le throttler — avait été calculé sur
   * un RTT Redis de 271 ms mesuré le 08/09. Vingt heures de production ont
   * donné ≈ 395 ms par commande, et 338 `Error: Command timed out` sur le
   * chemin du rate limiting : à chaque expiration, `ParallelThrottlerGuard`
   * laisse passer la requête **sans la compter**.
   *
   * Aucun test ne pouvait l'attraper, parce qu'aucun ne confrontait le plafond
   * à une latence réelle : ils vérifiaient que la valeur existait, qu'elle était
   * positive, et que les deux profils étaient ordonnés — tout cela était vrai
   * d'une valeur cassée.
   *
   * `RTT_MESURE_MS` est une **observation**, pas une préférence : la mettre à
   * jour demande une mesure, et la mesure est ce qui manquait. Le facteur 2 est
   * le minimum sous lequel un hoquet ordinaire suffit à faire tomber la garde.
   */
  it('chaque plafond garde une marge sur le RTT Redis réellement observé', () => {
    /** Sentry, 16/09/2026 : `lilia.redis.ms` ÷ `lilia.redis.calls`, n = 17. */
    const RTT_MESURE_MS = 395;

    for (const usage of ['business', 'throttler', 'tracking'] as const) {
      const { commandTimeout } = buildRedisOptions({ usage });

      expect(commandTimeout! / RTT_MESURE_MS).toBeGreaterThanOrEqual(2);
    }
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
