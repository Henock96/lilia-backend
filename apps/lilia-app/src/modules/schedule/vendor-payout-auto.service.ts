import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import * as Sentry from '@sentry/nestjs';

import { PrismaService } from '../../prisma/prisma.service';
import { CronLockService } from '../../common/locks/cron-lock.service';
import { PaymentProviderRegistry } from '../payments/payment-provider.registry';
import { RestaurantPayoutService } from '../payments/services/restaurant-payout.service';

/**
 * Versement automatique au vendeur (F3-07, décisions D5/D6).
 *
 * Un versement par commande, envoyé sans clic humain quand l'échéance est
 * passée. Le worker ne sait rien de la façon dont la remise a été prouvée :
 * il lit `Order.payoutDueAt`, que seule une preuve fiable pose (code livreur,
 * code comptoir, confirmation client, arbitrage admin — invariants I-6/I-7).
 *
 * Tout le reste est rejoué par `requestPayout`, sous verrou de la commande :
 * statut, remboursements en vol, compte de versement, carence de 24 h après
 * un changement de numéro, retenue de la dette. Une commande refusée (compte
 * absent, carence, remboursement ouvert) reste en file et sera reprise au
 * passage suivant ; un versement en ÉCHEC n'est jamais relancé seul — c'est
 * un geste humain (`retryPayout`), l'incident le signale.
 *
 * ⚠️ Éteint tant que `PlatformSettings.vendorPayoutAutoEnabled` est faux. Ne
 * l'allumer qu'avec le code client exigé à la livraison (L0-4), la validation
 * à deux administrateurs du numéro de versement (F3-08) et les apps publiées.
 */
@Injectable()
export class VendorPayoutAutoService {
  private readonly logger = new Logger(VendorPayoutAutoService.name);
  static readonly MAX_PER_RUN = 25;

  constructor(
    private readonly prisma: PrismaService,
    private readonly payouts: RestaurantPayoutService,
    private readonly registry: PaymentProviderRegistry,
    private readonly cronLock: CronLockService,
  ) {}

  @Cron('0 * * * * *', { name: 'vendor-payout-auto' })
  async run(): Promise<void> {
    await this.cronLock.runExclusively('vendor-payout-auto', 55, () =>
      this.runUnlocked(),
    );
  }

  /** Un passage. Rend le nombre de versements demandés (tests, journal). */
  async runUnlocked(now = new Date()): Promise<number> {
    const settings = await this.prisma.platformSettings.findUnique({
      where: { id: 'singleton' },
      select: { vendorPayoutAutoEnabled: true },
    });
    if (!settings?.vendorPayoutAutoEnabled) return 0;
    // Mode MANUAL : aucun prestataire ne sait verser, inutile de balayer.
    if (!this.registry.forPayout()) return 0;

    const due = await this.prisma.order.findMany({
      where: {
        status: 'LIVRER',
        payoutDueAt: { lte: now },
        payout: { is: null },
      },
      select: { id: true },
      orderBy: { payoutDueAt: 'asc' },
      take: VendorPayoutAutoService.MAX_PER_RUN,
    });

    let requested = 0;
    for (const { id } of due) {
      try {
        await this.payouts.requestPayout({
          orderId: id,
          adminUserId: null,
          trigger: 'AUTO',
        });
        requested++;
      } catch (error) {
        // Inéligible pour l'instant (409) : attendu, on repassera. Tout le
        // reste est une anomalie, mais ne bloque pas les commandes suivantes.
        if (error instanceof ConflictException) {
          this.logger.debug(
            `Versement automatique différé — commande ${id} : ${error.message}`,
          );
          continue;
        }
        this.logger.error(
          `Versement automatique en erreur — commande ${id} : ${(error as Error).message}`,
        );
        Sentry.captureException(error);
      }
    }
    if (requested > 0) {
      this.logger.log(`💸 ${requested} versement(s) automatique(s) demandé(s)`);
    }
    return requested;
  }
}
