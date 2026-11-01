import { Injectable, Logger, Optional } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import * as Sentry from '@sentry/nestjs';

import { shouldRunBackgroundJobs } from '../../config/background-jobs';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Verrou des tâches planifiées (fix M8 — audit du 28/08/2026).
 *
 * `@nestjs/schedule` exécute les crons dans **chaque** instance. La plupart des
 * jobs sont idempotents (`expireUnpaidOrders`, `handleDailyStockReset`), mais
 * `sendDailyReminders` envoie une notification par instance : le vendeur reçoit
 * le même rappel deux fois dès qu'on passe à deux instances Render.
 *
 * Durcissement lot 4 (30/10/2026) : le verrou est un **bail en base**
 * (`CronLease`), et non plus une clé Redis. Une panne Upstash laissait chaque
 * instance tourner sans verrou ; la base, elle, est déjà indispensable au
 * travail du cron. Pas de `pg_try_advisory_lock` : l'URL poolée de Neon
 * (PgBouncer en mode transaction) ne garantit pas qu'acquisition et libération
 * passent par la même session.
 */
@Injectable()
export class CronLockService {
  private readonly logger = new Logger(CronLockService.name);

  constructor(@Optional() private readonly prisma?: PrismaService) {}

  /**
   * Exécute `task` si et seulement si ce processus obtient le bail.
   *
   * @param jobName  identifiant du job (clé du bail)
   * @param ttlSeconds durée du bail — doit dépasser la durée d'exécution
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

    if (!this.prisma) {
      this.logger.warn(
        `Base absente — « ${jobName} » s'exécute sans verrou (doublons possibles en multi-instance).`,
      );
      return task();
    }

    // ⚠️ Jeton unique par exécution, et non un identifiant d'instance.
    //
    // Si une tâche dépasse son bail, une AUTRE instance le reprend
    // légitimement pendant qu'elle tourne encore ; la libération de la
    // première ne doit pas effacer le bail de la seconde. Elle est donc
    // conditionnée à ce jeton.
    const holder = randomUUID();

    let acquired: boolean;
    try {
      acquired = await this.acquire(jobName, holder, ttlSeconds);
    } catch (err) {
      // Même choix qu'avec Redis : l'expiration des commandes et le reset du
      // stock ne doivent pas s'éteindre sur une erreur de verrou. Le doublon
      // n'est possible qu'à plusieurs instances, l'absence l'est toujours.
      this.logger.error(
        `Verrou « ${jobName} » indisponible (${(err as Error).message}) — exécution sans verrou.`,
      );
      Sentry.captureException(err, {
        tags: { feature: 'cron-lease', job: jobName, degraded: 'true' },
      });
      return task();
    }

    if (!acquired) {
      this.logger.debug(
        `« ${jobName} » déjà pris en charge par une autre instance — ignoré.`,
      );
      return undefined;
    }

    try {
      return await task();
    } finally {
      // Libération explicite : un job court ne doit pas bloquer le suivant
      // pendant tout le bail. L'échéance reste le filet en cas de crash.
      await this.release(jobName, holder).catch((err: Error) =>
        this.logger.warn(
          `Bail « ${jobName} » non libéré (${err.message}) — il expirera seul.`,
        ),
      );
    }
  }

  /**
   * Une seule instruction : crée le bail, ou reprend un bail échu. Deux
   * instances concurrentes se sérialisent sur la clé primaire ; la seconde
   * relit le bail frais de la première, la condition `WHERE` échoue et
   * `RETURNING` ne rend rien.
   *
   * ⚠️ `timezone('UTC', now())` et non `now()` : les colonnes sont des
   * `timestamp` sans fuseau où Prisma écrit de l'UTC. Comparé à `now()`, un
   * bail frais paraissait échu dès que la session n'était pas en UTC
   * (`Africa/Brazzaville` en local : une heure d'écart).
   */
  private async acquire(
    jobName: string,
    holder: string,
    ttlSeconds: number,
  ): Promise<boolean> {
    const rows = await this.prisma!.$queryRaw<{ holder: string }[]>`
      INSERT INTO "CronLease" ("jobName", "holder", "acquiredAt", "expiresAt")
      VALUES (${jobName}, ${holder}, timezone('UTC', now()),
              timezone('UTC', now()) + make_interval(secs => ${ttlSeconds}::int))
      ON CONFLICT ("jobName") DO UPDATE
         SET "holder" = EXCLUDED."holder",
             "acquiredAt" = EXCLUDED."acquiredAt",
             "expiresAt" = EXCLUDED."expiresAt"
       WHERE "CronLease"."expiresAt" <= timezone('UTC', now())
      RETURNING "holder"`;
    return rows.length === 1 && rows[0].holder === holder;
  }

  /** Ne libère que son propre bail (comparaison et effacement atomiques). */
  private async release(jobName: string, holder: string): Promise<void> {
    const released = await this.prisma!.$executeRaw`
      DELETE FROM "CronLease"
       WHERE "jobName" = ${jobName} AND "holder" = ${holder}`;
    // Plus de bail à notre nom : la tâche a dépassé sa durée et une autre
    // instance a pu la relancer pendant qu'elle tournait.
    if (released === 0) {
      this.logger.warn(
        `Bail « ${jobName} » perdu avant la fin de la tâche : chevauchement possible, durée à revoir.`,
      );
    }
  }
}
