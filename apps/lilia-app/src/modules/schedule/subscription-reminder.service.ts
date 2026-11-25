import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { CronLockService } from '../../common/locks/cron-lock.service';
import { PrismaService } from '../../prisma/prisma.service';
import { SUBSCRIPTION_EXPIRING_EVENT } from '../outbox/outbox-events';
import { OutboxService } from '../outbox/outbox.service';

const HOUR_MS = 60 * 60 * 1000;

export type SubscriptionReminderTier = 'J3' | 'J0';

/**
 * Palier de rappel pour une échéance `paidUntil`, ou `null`.
 *
 * - `J0` : l'abonnement se termine dans les 24 h ;
 * - `J3` : il se termine entre 48 h et 72 h.
 *
 * Le cron passe toutes les heures : chaque échéance traverse chaque fenêtre
 * au moins une fois. L'unicité est portée par l'`aggregateId` de l'obligation
 * (`<boutique>:<échéance>:<palier>`), pas par la cadence.
 */
export function reminderTier(
  paidUntil: Date,
  now: Date,
): SubscriptionReminderTier | null {
  const left = paidUntil.getTime() - now.getTime();
  if (left <= 0) return null;
  if (left <= 24 * HOUR_MS) return 'J0';
  if (left > 48 * HOUR_MS && left <= 72 * HOUR_MS) return 'J3';
  return null;
}

/**
 * Premium S1 — prévient le vendeur que son abonnement arrive à échéance
 * (J-3, puis le jour même), pour qu'il le renouvelle depuis l'admin web.
 *
 * L'échéance d'un vendeur est la fin de sa **dernière** période encore due :
 * les périodes actives forment une suite continue (`entitlements.ts`), un
 * vendeur qui a déjà renouvelé n'est donc jamais rappelé.
 */
@Injectable()
export class SubscriptionReminderService {
  private readonly logger = new Logger(SubscriptionReminderService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
    private readonly cronLock: CronLockService,
  ) {}

  @Cron('17 * * * *', { name: 'subscription-expiry-reminders' })
  async run(): Promise<void> {
    await this.cronLock.runExclusively(
      'subscription-expiry-reminders',
      300,
      async () => {
        const sent = await this.remind(new Date());
        if (sent > 0) {
          this.logger.log(
            `👑 ${sent} rappel(s) d'échéance Premium programmé(s)`,
          );
        }
      },
    );
  }

  async remind(now: Date): Promise<number> {
    const ends = await this.prisma.vendorSubscription.groupBy({
      by: ['restaurantId'],
      where: { status: 'ACTIVE', endsAt: { gt: now } },
      _max: { endsAt: true },
    });

    let enqueued = 0;
    for (const row of ends) {
      const paidUntil = row._max.endsAt;
      if (!paidUntil) continue;
      const tier = reminderTier(paidUntil, now);
      if (!tier) continue;

      const aggregateId = `${row.restaurantId}:${paidUntil.toISOString()}:${tier}`;
      try {
        // Le cron tourne sous verrou exclusif : lire puis écrire suffit à ne
        // programmer qu'un rappel par échéance et par palier.
        const already = await this.prisma.outboxEvent.findFirst({
          where: { type: SUBSCRIPTION_EXPIRING_EVENT, aggregateId },
          select: { id: true },
        });
        if (already) continue;

        await this.prisma.$transaction((tx) =>
          this.outbox.enqueueInTransaction(tx, {
            type: SUBSCRIPTION_EXPIRING_EVENT,
            aggregateId,
            payload: {
              restaurantId: row.restaurantId,
              paidUntil: paidUntil.toISOString(),
              tier,
            },
          }),
        );
        enqueued++;
      } catch (error) {
        // Un vendeur en erreur n'empêche pas les rappels des autres ; il sera
        // repris au passage suivant (la fenêtre dure 24 h).
        this.logger.error(
          `Rappel d'échéance Premium non programmé pour ${row.restaurantId} : ${(error as Error).message}`,
        );
      }
    }
    return enqueued;
  }
}
