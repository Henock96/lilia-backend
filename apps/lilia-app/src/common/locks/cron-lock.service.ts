import { Injectable, Logger, Optional } from '@nestjs/common';
import { InjectRedis } from '@nestjs-modules/ioredis';
import Redis from 'ioredis';

/**
 * Verrou distribué pour les tâches planifiées (fix M8 — audit du 28/08/2026).
 *
 * `@nestjs/schedule` exécute les crons dans **chaque** instance. La plupart des
 * jobs sont idempotents (`expireUnpaidOrders`, `resetDailyStock`), mais
 * `sendDailyReminders` envoie une notification par instance : le vendeur reçoit
 * le même rappel deux fois dès qu'on passe à deux instances Render.
 *
 * Sans Redis, on n'a aucun moyen de coordonner les instances : on exécute
 * quand même (comportement historique, correct en mono-instance) mais on le
 * signale.
 */
@Injectable()
export class CronLockService {
  private readonly logger = new Logger(CronLockService.name);

  constructor(@Optional() @InjectRedis() private readonly redis?: Redis) {}

  /**
   * Exécute `task` si et seulement si ce processus obtient le verrou.
   *
   * @param jobName  identifiant du job (clé Redis)
   * @param ttlSeconds durée du verrou — doit dépasser la durée d'exécution
   *                   attendue, sinon deux instances peuvent se chevaucher.
   */
  async runExclusively<T>(
    jobName: string,
    ttlSeconds: number,
    task: () => Promise<T>,
  ): Promise<T | undefined> {
    const key = `cron_lock:${jobName}`;

    if (!this.redis) {
      this.logger.warn(
        `Redis absent — « ${jobName} » s'exécute sans verrou distribué (doublons possibles en multi-instance).`,
      );
      return task();
    }

    let acquired: string | null = null;
    try {
      acquired = await this.redis.set(key, '1', 'EX', ttlSeconds, 'NX');
    } catch (err) {
      // Une panne Redis ne doit pas empêcher les tâches critiques (expiration
      // des commandes, reset du stock) de tourner.
      this.logger.error(
        `Verrou « ${jobName} » indisponible (${(err as Error).message}) — exécution sans verrou.`,
      );
      return task();
    }

    if (acquired !== 'OK') {
      this.logger.debug(
        `« ${jobName} » déjà pris en charge par une autre instance — ignoré.`,
      );
      return undefined;
    }

    try {
      return await task();
    } finally {
      // On libère explicitement : un job court ne doit pas bloquer le suivant
      // pendant tout le TTL. Le TTL reste le filet en cas de crash.
      await this.redis.del(key).catch(() => undefined);
    }
  }
}
