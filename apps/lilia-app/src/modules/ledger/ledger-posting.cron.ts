import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import * as Sentry from '@sentry/nestjs';

import { CronLockService } from '../../common/locks/cron-lock.service';
import { CatchUpReport, LedgerPosterService } from './ledger-poster.service';

/**
 * Posteur du grand livre au fil de l'eau (lot 2, 30/10/2026).
 *
 * ⚠️ Éteint tant que `LEDGER_POSTING_ENABLED` n'est pas `true`. Lu à chaque
 * passage (pas à l'import du module) : allumer ou éteindre ne demande qu'un
 * redémarrage de configuration, jamais un déploiement.
 */
@Injectable()
export class LedgerPostingCron {
  private readonly logger = new Logger(LedgerPostingCron.name);

  constructor(
    private readonly poster: LedgerPosterService,
    private readonly cronLock: CronLockService,
    private readonly config: ConfigService,
  ) {}

  enabled(): boolean {
    const raw = this.config.get<string | boolean>('LEDGER_POSTING_ENABLED');
    return raw === true || raw === 'true';
  }

  @Cron('0 */10 * * * *', { name: 'ledger-posting' })
  async run(): Promise<void> {
    if (!this.enabled()) return;
    await this.cronLock.runExclusively('ledger-posting', 540, () =>
      this.runUnlocked(),
    );
  }

  async runUnlocked(): Promise<CatchUpReport | undefined> {
    try {
      const report = await this.poster.catchUp();
      const totals = Object.values(report).reduce(
        (acc, r) => ({
          posted: acc.posted + r.posted,
          exceptions: acc.exceptions + r.exceptions,
        }),
        { posted: 0, exceptions: 0 },
      );
      if (totals.posted || totals.exceptions) {
        this.logger.log(
          `Grand livre : ${totals.posted} écriture(s), ${totals.exceptions} exception(s)`,
        );
      }
      return report;
    } catch (err) {
      // Un passage raté est rejoué au suivant (idempotent) ; il ne doit pas
      // passer inaperçu pour autant.
      Sentry.captureException(err);
      this.logger.error(`Posteur du grand livre en échec : ${String(err)}`);
      return undefined;
    }
  }
}
