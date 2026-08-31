import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { PaymentEventSource, PayoutStatus } from '@prisma/client';
import * as Sentry from '@sentry/nestjs';

import { PrismaService } from '../../prisma/prisma.service';
import { CronLockService } from '../../common/locks/cron-lock.service';
import { PaymentService, maskRef } from '../payments/services/payment.service';
import { RestaurantPayoutService } from '../payments/services/restaurant-payout.service';
import { PaymentProviderRegistry } from '../payments/payment-provider.registry';

/**
 * Réconciliation des transactions restées en attente.
 *
 * Un callback peut se perdre : coupure réseau, instance Render endormie qui met
 * 30 à 60 secondes à répondre, redéploiement au mauvais moment. pawaPay rejoue
 * pendant 15 minutes, puis abandonne — et une transaction resterait `PENDING`
 * pour toujours. Côté encaissement, la commande finirait annulée par le cron
 * d'expiration alors que le client a payé ; côté reversement, un vendeur
 * attendrait un virement peut-être déjà parti.
 *
 * Ce cron interroge le prestataire et applique le résultat par **exactement le
 * même chemin que le webhook** (`applyCollectionProviderStatus` /
 * `applyPayoutProviderStatus`). Deux implémentations de la même décision
 * finiraient par diverger ; il n'y en a qu'une.
 */
@Injectable()
export class PaymentReconciliationService {
  private readonly logger = new Logger(PaymentReconciliationService.name);

  /**
   * Délai de grâce avant d'interroger une transaction.
   *
   * Un encaissement vient d'être initié : le client est en train de composer son
   * code. L'interroger immédiatement ne renvoie que `PENDING` et consomme un
   * appel facturé.
   */
  private static readonly GRACE_SECONDS = 180;

  /** Au-delà, on considère la transaction perdue et on la clôt. */
  private readonly abandonAfterMinutes: number;

  /** Garde-fou : mieux vaut finir au tour suivant qu'exploser. */
  private static readonly MAX_PER_RUN = 100;

  constructor(
    private readonly prisma: PrismaService,
    private readonly payments: PaymentService,
    private readonly payouts: RestaurantPayoutService,
    private readonly registry: PaymentProviderRegistry,
    private readonly cronLock: CronLockService,
    config: ConfigService,
  ) {
    this.abandonAfterMinutes = Number(
      config.get<number>('PAYMENT_RECONCILIATION_TIMEOUT_MINUTES', 15),
    );
  }

  @Cron('*/2 * * * *', { name: 'reconcile-pending-payments' })
  async reconcile(): Promise<void> {
    // Le traitement est idempotent, mais le verrou évite que deux instances
    // Render interrogent le prestataire en double — chaque appel est facturé.
    await this.cronLock.runExclusively('reconcile-pending-payments', 110, () =>
      this.reconcileUnlocked(),
    );
  }

  private async reconcileUnlocked(): Promise<void> {
    await Promise.all([this.reconcileCollections(), this.reconcilePayouts()]);
  }

  // ─── Encaissements ──────────────────────────────────────────────────────────

  private async reconcileCollections(): Promise<void> {
    const cutoff = new Date(
      Date.now() - PaymentReconciliationService.GRACE_SECONDS * 1000,
    );

    const stale = await this.prisma.payment.findMany({
      where: {
        status: 'PENDING',
        createdAt: { lt: cutoff },
        providerTransactionId: { not: null },
        // Le mode manuel n'a aucun prestataire à interroger : sa vérité est la
        // décision d'un administrateur.
        provider: { not: 'MANUAL' },
      },
      select: {
        id: true,
        provider: true,
        providerTransactionId: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'asc' },
      take: PaymentReconciliationService.MAX_PER_RUN,
    });

    if (stale.length === 0) return;

    let resolved = 0;
    let abandoned = 0;

    for (const payment of stale) {
      try {
        // ⚠️ Le provider est résolu d'après ce qui est STOCKÉ sur la ligne, pas
        // d'après le mode courant : un encaissement lancé via pawaPay doit être
        // réconcilié auprès de pawaPay même si la plateforme est repassée en
        // mode manuel entre-temps.
        const provider = this.registry.forStoredProvider(payment.provider);
        if (!provider.supportsCollection) continue;

        const status = await provider.getCollectionStatus(
          payment.providerTransactionId!,
        );

        if (status) {
          const outcome = await this.payments.applyCollectionProviderStatus({
            paymentId: payment.id,
            status,
            source: PaymentEventSource.RECONCILIATION,
          });
          if (outcome === 'APPLIED') resolved++;
          continue;
        }

        // `null` = le prestataire ne connaît pas la transaction. Soit elle n'est
        // jamais partie (panne à l'initiation), soit elle est trop récente.
        if (this.isAbandoned(payment.createdAt)) {
          await this.abandonCollection(payment.id);
          abandoned++;
        }
      } catch (error) {
        // Une transaction récalcitrante ne doit pas bloquer les suivantes.
        this.logger.error(
          `Réconciliation de l'encaissement ${payment.id} échouée : ${(error as Error).message}`,
        );
      }
    }

    if (resolved || abandoned) {
      this.logger.log(
        `🔄 Encaissements réconciliés : ${resolved} résolu(s), ${abandoned} abandonné(s) sur ${stale.length}`,
      );
    }
  }

  /**
   * Clôt un encaissement dont le prestataire ne sait rien après le délai.
   *
   * Passé en `FAILED` avec un code explicite : `RECONCILIATION_TIMEOUT` n'est
   * pas un refus du client, et la distinction compte pour l'analyse des échecs.
   * **La commande n'est pas touchée** — elle reste payable jusqu'à son
   * expiration propre.
   */
  private async abandonCollection(paymentId: string): Promise<void> {
    const claimed = await this.prisma.payment.updateMany({
      where: { id: paymentId, status: 'PENDING' },
      data: {
        status: 'FAILED',
        completedAt: new Date(),
        failureCode: 'RECONCILIATION_TIMEOUT',
        failureMessage:
          "Le prestataire n'a jamais confirmé cette transaction dans le délai imparti.",
      },
    });
    if (claimed.count === 0) return;

    this.logger.warn(
      `⏱️ Encaissement ${paymentId} abandonné — prestataire muet après ${this.abandonAfterMinutes} min`,
    );
    Sentry.captureMessage(
      `payment.reconciliation_timeout — encaissement ${paymentId}`,
      'warning',
    );
  }

  // ─── Reversements ───────────────────────────────────────────────────────────

  private async reconcilePayouts(): Promise<void> {
    const cutoff = new Date(
      Date.now() - PaymentReconciliationService.GRACE_SECONDS * 1000,
    );

    const stale = await this.prisma.restaurantPayout.findMany({
      where: {
        status: PayoutStatus.PENDING,
        requestedAt: { lt: cutoff },
        providerPayoutId: { not: null },
      },
      select: {
        id: true,
        provider: true,
        providerPayoutId: true,
        requestedAt: true,
      },
      orderBy: { requestedAt: 'asc' },
      take: PaymentReconciliationService.MAX_PER_RUN,
    });

    if (stale.length === 0) return;

    let resolved = 0;

    for (const payout of stale) {
      try {
        const provider = this.registry.forStoredProvider(payout.provider);
        if (!provider.supportsPayout) continue;

        const status = await provider.getPayoutStatus(payout.providerPayoutId!);

        if (status) {
          const outcome = await this.payouts.applyPayoutProviderStatus({
            payoutId: payout.id,
            status,
            source: PaymentEventSource.RECONCILIATION,
          });
          if (outcome === 'APPLIED') resolved++;
          continue;
        }

        // ⚠️ Asymétrie **délibérée** avec les encaissements : un reversement dont
        // le prestataire ne sait rien n'est PAS clôturé automatiquement.
        //
        // Un encaissement abandonné à tort ne coûte qu'une nouvelle demande au
        // client. Un reversement marqué en échec à tort invite un administrateur
        // à réessayer — et si la demande était en fait partie, le vendeur est
        // payé deux fois, sans récupération possible. On alerte, un humain
        // tranche.
        if (this.isAbandoned(payout.requestedAt)) {
          this.logger.error(
            `🚨 Reversement ${payout.id} sans statut après ${this.abandonAfterMinutes} min — ` +
              `ref ${maskRef(payout.providerPayoutId)}. Vérification manuelle requise.`,
          );
          Sentry.captureMessage(
            `payout.unknown_status — reversement ${payout.id} introuvable chez le prestataire`,
            'error',
          );
        }
      } catch (error) {
        this.logger.error(
          `Réconciliation du reversement ${payout.id} échouée : ${(error as Error).message}`,
        );
      }
    }

    if (resolved) {
      this.logger.log(
        `🔄 Reversements réconciliés : ${resolved} résolu(s) sur ${stale.length}`,
      );
    }
  }

  private isAbandoned(startedAt: Date): boolean {
    return Date.now() - startedAt.getTime() > this.abandonAfterMinutes * 60_000;
  }
}
