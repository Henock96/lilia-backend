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

/** 3,7 × le RTT observé depuis Render : absorbe un hoquet, coupe un blocage. */
export const DEFAULT_COMMAND_TIMEOUT_MS = 1_000;

/** Le rate limiting est une protection : il doit échouer vite. */
export const DEFAULT_THROTTLER_COMMAND_TIMEOUT_MS = 500;

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
