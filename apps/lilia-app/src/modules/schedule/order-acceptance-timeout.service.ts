import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../../prisma/prisma.service';
import { OrderLifecycleService } from '../orders/order-lifecycle.service';
import { CronLockService } from '../../common/locks/cron-lock.service';

/**
 * Expire les commandes payées que le vendeur n'a pas acceptées à temps
 * (Phase 3, F3-01 — décision D1 : 8 minutes).
 *
 * Toutes les 30 s : avec un délai de 8 min, un balayage toutes les 5 min
 * (cadence de l'expiration des impayés) laisserait un client attendre jusqu'à
 * 13 min. L'index `(status, acceptDeadlineAt)` rend la requête triviale.
 *
 * Rien ne se passe tant que `orderAcceptanceRequired` est faux : les
 * applications vendeur installées ne savent pas encore accepter.
 *
 * Concurrence : le verrou de cron évite deux balayages simultanés ; et quand
 * bien même, chaque expiration est un CAS `WHERE status = PAYER` — une
 * acceptation arrivée à la dernière seconde gagne ou perd proprement.
 */
@Injectable()
export class OrderAcceptanceTimeoutService {
  private readonly logger = new Logger(OrderAcceptanceTimeoutService.name);
  private static readonly MAX_PER_RUN = 50;

  constructor(
    private readonly prisma: PrismaService,
    private readonly lifecycle: OrderLifecycleService,
    private readonly cronLock: CronLockService,
  ) {}

  @Cron('*/30 * * * * *', { name: 'expire-unaccepted-orders' })
  async expireUnacceptedOrders(): Promise<void> {
    await this.cronLock.runExclusively('expire-unaccepted-orders', 25, () =>
      this.expireUnacceptedOrdersUnlocked(),
    );
  }

  private async expireUnacceptedOrdersUnlocked(): Promise<void> {
    const settings = await this.prisma.platformSettings.findUnique({
      where: { id: 'singleton' },
      select: { orderAcceptanceRequired: true },
    });
    if (!settings?.orderAcceptanceRequired) return;

    const due = await this.prisma.order.findMany({
      where: { status: 'PAYER', acceptDeadlineAt: { lte: new Date() } },
      select: { id: true },
      orderBy: { acceptDeadlineAt: 'asc' },
      take: OrderAcceptanceTimeoutService.MAX_PER_RUN,
    });

    for (const { id } of due) {
      try {
        await this.lifecycle.expireUnacceptedOrder(id);
      } catch (error) {
        // Une commande qui échoue ne doit pas bloquer les suivantes : elle
        // reste `PAYER` et sera reprise au prochain passage.
        this.logger.error(
          `⏱️ Expiration de la commande ${id} impossible : ${(error as Error).message}`,
        );
      }
    }
  }
}
