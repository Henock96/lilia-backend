import { Injectable, Logger, NestMiddleware } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as Sentry from '@sentry/nestjs';
import type { NextFunction, Request, Response } from 'express';

import { runWithRedisMetrics, type RedisCallStats } from './redis-metrics';

/**
 * Ouvre le contexte de mesure Redis pour toute la durée d'une requête HTTP.
 *
 * ⚠️ **Middleware et non intercepteur.** NestJS exécute les middlewares *avant*
 * les guards, et les intercepteurs *après*. Or les trois appels Redis qui pèsent
 * le plus lourd — les deux `EVAL` du `ThrottlerGuard` et le `GET` du cache
 * utilisateur du `RolesGuard` — ont lieu dans les guards. Un intercepteur les
 * raterait tous, et mesurerait une requête « sans Redis » là où elle en fait
 * trois.
 *
 * Ce qui sort d'ici :
 *  · des **attributs de span Sentry** (`lilia.redis.calls`, `lilia.redis.ms`),
 *    joints à la transaction HTTP déjà tracée, donc agrégeables en P50/P95/P99
 *    par route sans rien construire de plus ;
 *  · un log de debug **désactivé par défaut**, à n'activer que le temps d'une
 *    mesure (`REDIS_METRICS_LOG=true`).
 *
 * Ce qui n'en sort jamais : une clé, une valeur, un argument de commande, un
 * identifiant d'utilisateur. Seuls le nom de la commande, le compte et la durée
 * sont connus de ce code (cf. `redis-metrics.ts`).
 */
@Injectable()
export class RedisMetricsMiddleware implements NestMiddleware {
  private readonly logger = new Logger('RedisMetrics');
  private readonly logEnabled: boolean;

  constructor(config: ConfigService) {
    this.logEnabled = config.get<string>('REDIS_METRICS_LOG') === 'true';
  }

  use(req: Request, res: Response, next: NextFunction): void {
    runWithRedisMetrics((stats) => {
      const startedAt = process.hrtime.bigint();

      // `finish` plutôt que `close` : on veut le moment où la réponse est
      // écrite, pas celui où le client raccroche.
      res.once('finish', () => {
        const totalMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
        this.report(req, stats, totalMs);
      });

      next();
    });
  }

  private report(req: Request, stats: RedisCallStats, totalMs: number): void {
    // Sans appel Redis il n'y a rien à expliquer : on n'alourdit pas les spans
    // des routes déjà exemptées (`/health*`).
    if (stats.calls === 0) return;

    Sentry.getActiveSpan()?.setAttributes({
      'lilia.redis.calls': stats.calls,
      'lilia.redis.ms': Math.round(stats.durationMs),
      'lilia.request.ms': Math.round(totalMs),
    });

    if (this.logEnabled) {
      // `req.route?.path` est le motif de route (`/orders/:id`), pas l'URL
      // réelle : aucun identifiant ne fuit. Repli sur la méthode seule si Nest
      // n'a pas résolu de route (404).
      const route = (req as { route?: { path?: string } }).route?.path;
      this.logger.debug(
        `${req.method} ${route ?? '(non routé)'} — redis ${stats.calls} appels / ` +
          `${stats.durationMs.toFixed(1)} ms sur ${totalMs.toFixed(1)} ms ` +
          `(${this.formatCommands(stats)})`,
      );
    }
  }

  private formatCommands(stats: RedisCallStats): string {
    return Object.entries(stats.byCommand)
      .sort(([, a], [, b]) => b - a)
      .map(([name, count]) => `${name}×${count}`)
      .join(' ');
  }
}
