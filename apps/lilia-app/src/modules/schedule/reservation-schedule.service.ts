import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { CronLockService } from '../../common/locks/cron-lock.service';
import { ReservationLifecycleService } from '../reservations/reservation-lifecycle.service';

/**
 * Lot 4 — les trois tâches de fond des réservations sur place.
 *
 * Toutes passent par `CronLockService.runExclusively` (un seul processus à la
 * fois) ; chaque écriture est de toute façon conditionnelle, un tour rejoué
 * ne double rien. Interrupteur éteint : aucune réservation n'existe, chaque
 * tour lit une table vide.
 */
@Injectable()
export class ReservationScheduleService {
  private readonly logger = new Logger(ReservationScheduleService.name);

  constructor(
    private readonly lifecycle: ReservationLifecycleService,
    private readonly cronLock: CronLockService,
  ) {}

  /** Échéances de réponse (30 min) et de paiement (15 min) : à la minute. */
  @Cron('0 * * * * *', { name: 'expire-reservations' })
  async expire(): Promise<void> {
    await this.cronLock.runExclusively('expire-reservations', 50, async () => {
      const n = await this.lifecycle.expireOverdue();
      if (n > 0) this.logger.log(`⏰ ${n} réservation(s) expirée(s)`);
    });
  }

  /** Rappel 2 h avant l'arrivée (B7). */
  @Cron('*/5 * * * *', { name: 'reservation-reminders' })
  async remind(): Promise<void> {
    await this.cronLock.runExclusively(
      'reservation-reminders',
      240,
      async () => {
        const n = await this.lifecycle.sendReminders();
        if (n > 0) this.logger.log(`⏰ ${n} rappel(s) de réservation`);
      },
    );
  }

  /** Récapitulatif du jour à 8 h, heure de Brazzaville (07:00 UTC, B7). */
  @Cron('0 7 * * *', { name: 'reservation-daily-summary' })
  async summarize(): Promise<void> {
    await this.cronLock.runExclusively(
      'reservation-daily-summary',
      600,
      async () => {
        const n = await this.lifecycle.sendDailySummaries();
        if (n > 0) this.logger.log(`📋 ${n} récapitulatif(s) envoyé(s)`);
      },
    );
  }
}
