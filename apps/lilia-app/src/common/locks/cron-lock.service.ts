import { Injectable, Logger, Optional } from '@nestjs/common';
import { InjectRedis } from '@nestjs-modules/ioredis';
import Redis from 'ioredis';

import { shouldRunBackgroundJobs } from '../../config/background-jobs';

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
    // `RUN_BACKGROUND_JOBS` est lu **ici**, à l'exécution, et non à la
    // construction des modules (audit post-correction, B-2).
    //
    // Les modules filtraient déjà leurs providers avec `shouldRunBackgroundJobs()`,
    // mais un décorateur `@Module` s'évalue à l'import du fichier — donc avant
    // que `ConfigModule.forRoot()` n'ait chargé le `.env`. Un
    // `RUN_BACKGROUND_JOBS=false` posé dans un fichier `.env` était donc lu
    // comme `undefined`, et le processus web continuait à exécuter les crons
    // qu'on croyait avoir désactivés. Sur Render la variable est un vrai
    // `process.env` et le filtre fonctionnait ; en local et sur tout
    // déploiement qui s'appuie sur un `.env`, non.
    //
    // Tous les jobs de fond passent par ce point d'entrée : c'est le seul
    // endroit où la garde est à la fois unique et évaluée assez tard.
    if (!shouldRunBackgroundJobs()) {
      this.logger.debug(
        `« ${jobName} » ignoré : RUN_BACKGROUND_JOBS=false sur ce processus.`,
      );
      return undefined;
    }

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
