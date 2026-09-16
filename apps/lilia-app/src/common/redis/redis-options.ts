import type { ConfigService } from '@nestjs/config';
import type { RedisOptions } from 'ioredis';

/**
 * Options de connexion ioredis, **différenciées par usage**.
 *
 * ## Le problème que ce fichier corrige
 *
 * Aucune option n'était fournie nulle part : `RedisModule.forRootAsync({ type:
 * 'single', url })`, `new ThrottlerStorageRedisService(url)`, `new Redis(url)`.
 * Les défauts d'ioredis sont alors `maxRetriesPerRequest: 20`,
 * `enableOfflineQueue: true` et **aucun `commandTimeout`**.
 *
 * Conséquence mesurable : avec un Redis à ~271 ms, une indisponibilité ne
 * dégrade pas la plateforme, elle la **gèle**. Les replis sont pourtant écrits
 * — `UserCacheService` retombe sur Prisma, `OrderCheckoutService` continue sans
 * garde en alertant Sentry — mais ils ne peuvent s'exécuter qu'une fois la
 * commande en échec, et sans `commandTimeout` cet échec peut n'arriver qu'au
 * bout de plusieurs secondes. Le repli existait ; ce qui manquait, c'est ce qui
 * le déclenche.
 *
 * ## Pourquoi trois profils et pas un réglage global
 *
 * Les trois usages n'ont pas la même tolérance :
 *
 * | Usage | Ce qu'on perd si la commande échoue | Donc |
 * |---|---|---|
 * | **métier** (idempotence du checkout, verrous de cron) | une **garantie**, pas du confort : un checkout non protégé peut créer deux commandes | patient |
 * | **throttler** | une **protection** — la requête reste correcte sans elle | impatient |
 * | **tracking** | une position qui sera remplacée 5 s plus tard | impatient |
 *
 * Appliquer le réglage du throttler au client métier reviendrait à dégrader une
 * garantie métier pour gagner de la latence.
 *
 * ## `enableOfflineQueue` reste à `true`, délibérément
 *
 * Le passer à `false` fait échouer **immédiatement** toute commande émise
 * pendant une reconnexion — y compris la réservation d'idempotence du checkout,
 * pour une coupure d'une seconde. Le `commandTimeout` borne déjà l'attente, et
 * il la borne *sans* transformer chaque micro-coupure en perte de garantie.
 */

/**
 * ## ⚠️ Les deux valeurs ci-dessous ont été relevées le 16/09/2026
 *
 * Elles avaient été dimensionnées sur **271 ms**, le RTT Redis mesuré depuis
 * Render le 08/09. Vingt heures après la mise en production du profil de
 * timeouts, l'instrumentation dit autre chose :
 *
 *     lilia.redis.ms ≈ 790 ms pour lilia.redis.calls = 2
 *     → ≈ 395 ms par commande, sur 17 requêtes publiques (753–838 ms cumulés)
 *
 * Et cette moyenne est **sous-estimée par construction** : elle n'est calculée
 * que sur les requêtes dont les commandes ont abouti, donc sous l'ancien
 * plafond de 500 ms. Les autres sont parties en `Error: Command timed out` —
 * 338 occurrences en 20 heures (Sentry `LILIA-FOOD-BACKEND-G`, tags
 * `feature: rate-limiting`, `degraded: true`, première occurrence **75 secondes
 * après le démarrage** du binaire).
 *
 * La conséquence n'est pas cosmétique. `ParallelThrottlerGuard` rattrape
 * l'échec et **laisse passer la requête sans compteur** : à chaque expiration,
 * le rate limiting — la protection posée par le point C4 de l'audit du 28/08 —
 * est absent. Un plafond qui se déclenche sur le chemin nominal n'est pas une
 * politique d'échec rapide, c'est une panne de la protection qu'il garde.
 *
 * Elles restent surchargeables par variable d'environnement : un incident de
 * production se traite en posant `REDIS_THROTTLER_COMMAND_TIMEOUT_MS` sur
 * Render, sans attendre un redéploiement de ce fichier.
 */

/** ≈ 7,6 × le RTT mesuré. Profil patient : il garde une garantie métier. */
export const DEFAULT_COMMAND_TIMEOUT_MS = 3_000;

/**
 * Le rate limiting est une protection : il doit échouer vite — mais **plus
 * tard que le chemin nominal**, sans quoi il n'échoue pas vite, il échoue
 * toujours. ≈ 3,8 × le RTT mesuré, soit la marge que le profil métier avait
 * à l'origine.
 */
export const DEFAULT_THROTTLER_COMMAND_TIMEOUT_MS = 1_500;

/** Borne l'établissement de connexion, indépendante des commandes. */
export const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;

export type RedisUsage = 'business' | 'throttler' | 'tracking';

interface BuildOptions {
  usage: RedisUsage;
  config?: Pick<ConfigService, 'get'>;
}

/**
 * Construit les options ioredis pour un usage donné.
 *
 * Les deux délais sont surchargeables par variable d'environnement, pour qu'un
 * incident de production puisse être traité sans redéploiement de code.
 */
export function buildRedisOptions({
  usage,
  config,
}: BuildOptions): RedisOptions {
  const commandTimeout =
    usage === 'throttler'
      ? readMs(
          config,
          'REDIS_THROTTLER_COMMAND_TIMEOUT_MS',
          DEFAULT_THROTTLER_COMMAND_TIMEOUT_MS,
        )
      : readMs(config, 'REDIS_COMMAND_TIMEOUT_MS', DEFAULT_COMMAND_TIMEOUT_MS);

  return {
    commandTimeout,
    connectTimeout: readMs(
      config,
      'REDIS_CONNECT_TIMEOUT_MS',
      DEFAULT_CONNECT_TIMEOUT_MS,
    ),
    // Un seul réessai hors usage métier : au-delà, on préfère le repli au
    // chemin nominal. Le client métier en garde deux — un `SET NX`
    // d'idempotence mérite qu'on insiste un peu avant de renoncer à la garde.
    maxRetriesPerRequest: usage === 'business' ? 2 : 1,
    // Volontairement laissé au défaut (`true`). Voir l'en-tête du fichier.
    enableOfflineQueue: true,
  };
}

function readMs(
  config: Pick<ConfigService, 'get'> | undefined,
  key: string,
  fallback: number,
): number {
  const raw = config?.get<string | number>(key);
  const parsed =
    typeof raw === 'number' ? raw : raw != null ? Number(raw) : Number.NaN;
  // Une valeur mal saisie ne doit pas produire un timeout de 0 ms — qui ferait
  // échouer *toutes* les commandes — ni un `NaN`, qu'ioredis interprète comme
  // « pas de limite », c'est-à-dire exactement le défaut qu'on corrige.
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
