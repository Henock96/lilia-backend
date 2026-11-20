import { ConfigService } from '@nestjs/config';
import type { PoolConfig } from 'pg';

/**
 * Configuration du pool `pg` derrière l'adaptateur Prisma.
 *
 * ## Pourquoi ne pas laisser les défauts
 *
 * `pg-pool` ferme une connexion inactive au bout de **10 s** et n'en garde
 * aucune (`min: 0`). Or ouvrir une connexion vers Neon depuis Render coûte une
 * poignée de main TCP + TLS + authentification à travers le continent : Sentry
 * mesurait `pg-pool.connect` à 722 ms en moyenne, 1,1 s au p95 (17/11/2026),
 * pour des requêtes qui, elles, prennent ~60 ms.
 *
 * Les tâches planifiées passent toutes les minutes : le pool était vide à
 * chaque passage, et chacune payait la reconnexion — d'où les « Slow DB Query »
 * sur des lectures par clé primaire. Une requête HTTP arrivant après dix
 * secondes de calme la payait aussi.
 *
 * `min` garde quelques connexions ouvertes en permanence ; `idleTimeoutMillis`
 * laisse vivre plus longtemps celles ouvertes au-delà, pendant une rafale. Une
 * connexion coupée côté serveur est retirée du pool : l'adaptateur écoute
 * l'erreur des clients inactifs, le processus ne tombe pas.
 *
 * ## Le prix d'une connexion qui vit longtemps
 *
 * `pg-pool` réutilise la dernière connexion rendue (pile) : sous `min`, la
 * seconde peut rester inactive des heures. Un intermédiaire entre Render et
 * Neon (NAT, répartiteur, proxy) qui la coupe sans prévenir la laisse morte
 * dans le pool, et la requête suivante qui la prend échoue — ou attend.
 * Avant ce réglage, aucune connexion ne restait inactive plus de 10 s.
 *
 * - `keepAlive` : sondes TCP toutes les 30 s ; elles entretiennent la
 *   connexion aux yeux des intermédiaires et révèlent celle qui est morte,
 *   que le pool retire alors.
 * - `maxLifetimeSeconds` : chaque connexion est remplacée au bout de 30 min,
 *   ce qui borne l'exposition si les sondes ne suffisent pas.
 */
export const DEFAULT_POOL_MIN = 2;
export const DEFAULT_POOL_IDLE_TIMEOUT_MS = 300_000;
export const POOL_KEEPALIVE_INITIAL_DELAY_MS = 30_000;
export const POOL_MAX_LIFETIME_SECONDS = 1_800;

export function buildPoolConfig(config: ConfigService): PoolConfig {
  return {
    connectionString: config.get<string>('DATABASE_URL'),
    min: config.get<number>('DATABASE_POOL_MIN', DEFAULT_POOL_MIN),
    idleTimeoutMillis: config.get<number>(
      'DATABASE_POOL_IDLE_TIMEOUT_MS',
      DEFAULT_POOL_IDLE_TIMEOUT_MS,
    ),
    keepAlive: true,
    keepAliveInitialDelayMillis: POOL_KEEPALIVE_INITIAL_DELAY_MS,
    maxLifetimeSeconds: POOL_MAX_LIFETIME_SECONDS,
  };
}
