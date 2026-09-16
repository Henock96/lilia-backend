import { AsyncLocalStorage } from 'node:async_hooks';
import Redis from 'ioredis';

/**
 * Comptage des appels Redis par requête HTTP.
 *
 * ## Pourquoi une instrumentation maison plutôt que celle de Sentry
 *
 * `Sentry.redisIntegration()` **existe** et n'est pas activée. Ce n'est pas un
 * problème d'ordre de chargement — `instrument.ts` est bien le premier import de
 * `main.ts` — c'est que `Redis` ne fait **pas partie** des intégrations par
 * défaut de `@sentry/node` v10 (vérifié : `getDefaultIntegrations()` rend 17
 * intégrations, aucune Redis).
 *
 * Elle n'est pas activée pour autant, parce que son sérialiseur
 * (`defaultDbStatementSerializer`) envoie les **arguments** des commandes dans
 * `db.statement`, et que dans notre cas ces arguments sont exactement ce qu'il
 * ne faut pas exporter :
 *
 * | Commande                                   | Ce qui partirait chez Sentry     |
 * |--------------------------------------------|----------------------------------|
 * | `GET user:fbuid:<uid>`                     | l'UID Firebase, en clair         |
 * | `SET idempotency:<uid>:<clé>`              | l'UID et la clé d'idempotence    |
 * | `GEOADD driver_positions <lng> <lat> <id>` | la position GPS du livreur       |
 *
 * L'option `redisIntegration({...})` de cette version n'expose que
 * `cachePrefixes` : aucun moyen de fournir un sérialiseur. On mesure donc
 * nous-mêmes, et **on ne retient que le nom de la commande et sa durée**.
 * Aucun argument n'est lu, copié, ni même conservé le temps d'un log.
 *
 * ## Portée
 *
 * Le contexte est ouvert par `RedisMetricsMiddleware` — un **middleware**, et non
 * un intercepteur, parce que les intercepteurs Nest s'exécutent *après* les
 * guards : ils rateraient précisément les trois appels qu'on cherche à mesurer
 * (les deux du `ThrottlerGuard` et celui du cache utilisateur du `RolesGuard`).
 *
 * Hors contexte — crons, listeners, WebSocket — le patch ne fait rien.
 */

export interface RedisCallStats {
  /** Nombre de commandes Redis émises pendant la requête. */
  calls: number;
  /** Temps cumulé passé à attendre Redis, en millisecondes. */
  durationMs: number;
  /** Nombre d'appels par nom de commande. **Jamais d'arguments.** */
  byCommand: Record<string, number>;
}

const storage = new AsyncLocalStorage<RedisCallStats>();

/** Ouvre un contexte de mesure et exécute `fn` dedans. */
export function runWithRedisMetrics<T>(fn: (stats: RedisCallStats) => T): T {
  const stats: RedisCallStats = { calls: 0, durationMs: 0, byCommand: {} };
  return storage.run(stats, () => fn(stats));
}

/** Statistiques du contexte courant, ou `undefined` hors requête. */
export function currentRedisStats(): RedisCallStats | undefined {
  return storage.getStore();
}

/** Marqueur d'idempotence : instrumenter deux fois doublerait les compteurs. */
const INSTRUMENTED = Symbol('lilia.redisMetricsInstrumented');

type SendCommandHost = {
  sendCommand: (...args: unknown[]) => unknown;
  [INSTRUMENTED]?: boolean;
};

/**
 * Enveloppe `sendCommand` pour compter les commandes qui le traversent.
 *
 * `sendCommand` est le goulot par lequel **toutes** les commandes ioredis
 * passent, y compris celles d'un `pipeline()` (une entrée par commande) et
 * celles émises par les bibliothèques tierces branchées sur le même client.
 *
 * Accepte aussi bien une **instance** qu'un **prototype** : `original` est
 * appelée avec `apply(this, …)` et non liée à la cible, sans quoi patcher
 * `Redis.prototype` enverrait toutes les commandes de tous les clients sur le
 * prototype lui-même.
 *
 * Patcher le prototype est le seul moyen de couvrir les cinq connexions du
 * processus — celle du `RedisModule`, celle du throttler et celle du tracking
 * sont construites par des bibliothèques qui ne nous rendent pas la main sur
 * l'instance.
 */
export function instrumentRedisClient<T>(client: T): T {
  const host = client as unknown as SendCommandHost | null;
  if (!host || typeof host.sendCommand !== 'function') return client;
  if (host[INSTRUMENTED]) return client;

  const original = host.sendCommand;

  host.sendCommand = function patchedSendCommand(
    this: unknown,
    ...args: unknown[]
  ) {
    const stats = storage.getStore();
    if (!stats) return original.apply(this, args);

    // Seul le NOM est lu. `args[0]` est la commande ioredis ; ses `args`
    // (clés, valeurs) ne sont ni lus ni conservés.
    const name = readCommandName(args[0]);
    const startedAt = process.hrtime.bigint();

    const settle = () => {
      const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
      stats.calls += 1;
      stats.durationMs += elapsedMs;
      stats.byCommand[name] = (stats.byCommand[name] ?? 0) + 1;
    };

    const result = original.apply(this, args);

    // ioredis rend un objet `Command` porteur d'une promesse, pas la promesse
    // elle-même. On s'accroche à `promise` quand elle existe, et on retombe sur
    // un décompte immédiat sinon — mieux vaut une durée sous-estimée qu'un
    // compteur faux.
    const promise = (result as { promise?: Promise<unknown> } | null)?.promise;
    if (promise && typeof promise.then === 'function') {
      promise.then(settle, settle);
    } else if (isThenable(result)) {
      (result as Promise<unknown>).then(settle, settle);
    } else {
      settle();
    }

    return result;
  };

  host[INSTRUMENTED] = true;
  return client;
}

/** Le nom de la commande, en minuscules. Rien d'autre. */
function readCommandName(command: unknown): string {
  const name = (command as { name?: unknown } | null)?.name;
  return typeof name === 'string' && name.length > 0
    ? name.toLowerCase()
    : 'unknown';
}

function isThenable(value: unknown): value is Promise<unknown> {
  return typeof (value as { then?: unknown } | null)?.then === 'function';
}

/**
 * Instrumente **toutes** les connexions ioredis du processus, présentes et à
 * venir, en enveloppant le prototype.
 *
 * À appeler une fois au démarrage. Idempotent : un second appel ne fait rien.
 *
 * C'est le seul point d'accroche qui couvre les cinq connexions : celle du
 * `RedisModule`, celle que `ThrottlerStorageRedisService` ouvre à partir d'une
 * URL, celle de `TrackingService`, et les deux du `RedisIoAdapter`. Aucune de
 * ces bibliothèques ne rend l'instance construite.
 */
export function instrumentIoredis(): void {
  instrumentRedisClient(Redis.prototype as unknown as object);
}

/** Type d'entrée accepté par `instrumentRedisClient`, pour les appelants typés. */
export type InstrumentableRedis = Redis;
