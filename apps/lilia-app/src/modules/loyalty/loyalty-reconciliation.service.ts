/* eslint-disable prettier/prettier */
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import * as Sentry from '@sentry/nestjs';

import { PrismaService } from '../../prisma/prisma.service';
import { CronLockService } from '../../common/locks/cron-lock.service';

export interface LoyaltyDrift {
  userId: string;
  balance: number;
  ledgerSum: number;
  drift: number;
}

/**
 * Réconciliation du solde de fidélité (fix M13 — audit du 28/08/2026).
 *
 * `User.loyaltyPoints` est la source de vérité, écrite par cinq chemins
 * différents (raw SQL conditionnel au checkout, trois `increment`, et les
 * compensations d'annulation), tandis que `LoyaltyTransaction` tient le ledger.
 * Rien ne vérifiait que `SUM(points) == loyaltyPoints` : une divergence — donc
 * de l'argent créé ou perdu — était **invisible**.
 *
 * Ce job la rend visible. Il ne corrige rien automatiquement : un écart peut
 * venir d'un bug comme d'une écriture manuelle légitime, et réécrire un solde
 * sans comprendre pourquoi il a dérivé ferait plus de dégâts que l'écart.
 */
@Injectable()
export class LoyaltyReconciliationService {
  private readonly logger = new Logger(LoyaltyReconciliationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cronLock: CronLockService,
  ) {}

  /** 3h30 UTC (4h30 à Brazzaville) : hors des heures de commande. */
  @Cron('30 3 * * *', { name: 'loyalty-reconciliation' })
  async runDailyCheck(): Promise<void> {
    await this.cronLock.runExclusively('loyalty-reconciliation', 900, () =>
      this.reportDrifts(),
    );
  }

  /**
   * Compare, pour chaque compte ayant un solde ou des écritures, le solde
   * dénormalisé et la somme du ledger.
   */
  async findDrifts(limit = 100): Promise<LoyaltyDrift[]> {
    // Une seule requête : PostgreSQL agrège le ledger et le confronte au solde.
    // `COALESCE` couvre les comptes sans aucune écriture (solde attendu 0).
    return this.prisma.$queryRaw<LoyaltyDrift[]>`
      SELECT u.id                                     AS "userId",
             u."loyaltyPoints"                        AS "balance",
             COALESCE(SUM(lt.points), 0)::int         AS "ledgerSum",
             (u."loyaltyPoints" - COALESCE(SUM(lt.points), 0))::int AS "drift"
        FROM "User" u
        LEFT JOIN "LoyaltyTransaction" lt ON lt."userId" = u.id
       GROUP BY u.id, u."loyaltyPoints"
      HAVING u."loyaltyPoints" <> COALESCE(SUM(lt.points), 0)
       ORDER BY ABS(u."loyaltyPoints" - COALESCE(SUM(lt.points), 0)) DESC
       LIMIT ${limit}
    `;
  }

  private async reportDrifts(): Promise<void> {
    const drifts = await this.findDrifts();

    if (drifts.length === 0) {
      this.logger.log('✅ Fidélité : solde et ledger concordent sur tous les comptes.');
      return;
    }

    const totalDrift = drifts.reduce((sum, d) => sum + Math.abs(d.drift), 0);

    this.logger.error(
      `⚠️ Fidélité : ${drifts.length} compte(s) en écart, ${totalDrift} points au total. ` +
        `Plus gros écart : user ${drifts[0].userId} (${drifts[0].drift} pts).`,
    );

    // Remontée explicite : un écart de points est un écart d'argent
    // (1 pt = 5 XAF), il doit atterrir dans la boîte de réception, pas dans un
    // fichier de logs que personne ne relit.
    Sentry.captureMessage(
      `Divergence solde/ledger fidélité : ${drifts.length} compte(s), ${totalDrift} pts`,
      {
        level: 'error',
        extra: { sample: drifts.slice(0, 10) },
      },
    );
  }
}
