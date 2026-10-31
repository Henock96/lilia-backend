import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { PrismaService } from '../../prisma/prisma.service';
import { OrderLifecycleService } from '../orders/order-lifecycle.service';
import { CronLockService } from '../../common/locks/cron-lock.service';

/**
 * Expiration des demandes sans réponse du vendeur (durcissement lot 3).
 *
 * Parcours `ACCEPT_FIRST` seulement : une commande `DEMANDE_ENVOYEE` dont
 * l'échéance (`requestExpiresAt`) est passée est annulée — stock rendu, client
 * et vendeur prévenus, **aucun remboursement** (rien n'a pu être encaissé).
 *
 * Sans commande `ACCEPT_FIRST` (réglage par défaut), la requête ne trouve
 * rien : le cron est inerte. Le verrou `WHERE status = DEMANDE_ENVOYEE`
 * départage une acceptation arrivée à la dernière seconde.
 */
@Injectable()
export class OrderRequestExpiryService {
  private readonly logger = new Logger(OrderRequestExpiryService.name);
  static readonly MAX_PER_RUN = 50;

  constructor(
    private readonly prisma: PrismaService,
    private readonly lifecycle: OrderLifecycleService,
    private readonly cronLock: CronLockService,
  ) {}

  @Cron('*/30 * * * * *', { name: 'expire-order-requests' })
  async run(): Promise<void> {
    await this.cronLock.runExclusively('expire-order-requests', 25, () =>
      this.runUnlocked(),
    );
  }

  /** Un passage. Rend le nombre de demandes expirées (tests, journal). */
  async runUnlocked(now = new Date()): Promise<number> {
    const due = await this.prisma.order.findMany({
      where: { status: 'DEMANDE_ENVOYEE', requestExpiresAt: { lte: now } },
      select: { id: true },
      orderBy: { requestExpiresAt: 'asc' },
      take: OrderRequestExpiryService.MAX_PER_RUN,
    });

    let expired = 0;
    for (const { id } of due) {
      try {
        if (await this.lifecycle.expireRequest(id, now)) expired++;
      } catch (error) {
        // Une demande qui résiste ne bloque pas les suivantes : elle reste
        // `DEMANDE_ENVOYEE` et sera reprise au passage suivant.
        this.logger.error(
          `⏱️ Expiration de la demande ${id} impossible : ${(error as Error).message}`,
        );
      }
    }
    return expired;
  }
}
