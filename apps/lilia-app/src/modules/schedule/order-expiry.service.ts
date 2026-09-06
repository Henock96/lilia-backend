import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';

import { PrismaService } from '../../prisma/prisma.service';
import { OrderLifecycleService } from '../orders/order-lifecycle.service';
import { CronLockService } from '../../common/locks/cron-lock.service';

/**
 * Expiration des commandes jamais payées.
 *
 * Le stock est réservé au checkout (`stock.service.decrementInTransaction`),
 * pas au paiement. En mode `PAYMENT_MODE=MANUAL` — le mode de production — le
 * paiement dépend d'une action humaine du client puis d'une confirmation admin :
 * un abandon en cours de route immobilisait le stock jusqu'au reset quotidien
 * de 5 h, et **définitivement** pour les produits `stockMode = PERMANENT` que
 * ce reset ne touche pas.
 *
 * Ce cron ferme la boucle : au-delà du délai, la commande est annulée et tout
 * ce que le checkout avait prélevé est restitué (stock, points, code promo).
 */
@Injectable()
export class OrderExpiryService {
  private readonly logger = new Logger(OrderExpiryService.name);

  /** Délai avant expiration d'une commande dont le paiement n'a jamais démarré. */
  private readonly timeoutMinutes: number;
  /**
   * Délai, plus long, pour une commande portant un `Payment` PENDING : en mode
   * MANUAL le client a peut-être bien envoyé l'argent et c'est la confirmation
   * admin qui traîne. On lui laisse largement le temps avant d'annuler.
   */
  private readonly pendingTimeoutMinutes: number;
  /**
   * Délai, court, quand le prestataire a **définitivement refusé** le paiement.
   *
   * Le seuil général de 45 min a été calibré pour le mode `MANUAL` de mai
   * 2026 : le client devait composer un code USSD puis un administrateur
   * retrouver le virement. Avec pawaPay, qui tranche en une minute, une
   * commande dont le débit a été refusé immobilise le stock 43 minutes de plus
   * pour rien — sur un produit à un exemplaire, c'est trois quarts d'heure
   * pendant lesquels personne d'autre ne peut l'acheter parce qu'un client
   * n'avait pas assez de crédit.
   *
   * ⚠️ L'invariant « un échec de paiement n'annule jamais une commande » est
   * **conservé** : c'est lui qui rend la reprise possible. On ne raccourcit que
   * le délai au bout duquel une commande *abandonnée après un échec* rend son
   * stock. 10 minutes laissent largement le temps de réessayer — et si le
   * client réessaie, un nouveau `Payment` PENDING apparaît et la commande
   * retombe sous le seuil long.
   */
  private readonly failedTimeoutMinutes: number;
  /** Garde-fou : au-delà, on préfère traiter au tour suivant qu'exploser. */
  private static readonly MAX_PER_RUN = 200;

  constructor(
    private readonly prisma: PrismaService,
    private readonly lifecycle: OrderLifecycleService,
    private readonly config: ConfigService,
    private readonly cronLock: CronLockService,
  ) {
    this.timeoutMinutes =
      this.config.get<number>('ORDER_PAYMENT_TIMEOUT_MINUTES') ?? 45;
    this.pendingTimeoutMinutes =
      this.config.get<number>('ORDER_PENDING_PAYMENT_TIMEOUT_MINUTES') ?? 360;
    this.failedTimeoutMinutes =
      this.config.get<number>('ORDER_FAILED_PAYMENT_TIMEOUT_MINUTES') ?? 10;
  }

  @Cron('*/5 * * * *', { name: 'expire-unpaid-orders' })
  async expireUnpaidOrders(): Promise<void> {
    // Le job est idempotent (`updateMany` conditionné sur EN_ATTENTE), mais le
    // verrou évite que deux instances fassent le même travail et se disputent
    // les mêmes lignes (fix M8).
    await this.cronLock.runExclusively('expire-unpaid-orders', 240, () =>
      this.expireUnpaidOrdersUnlocked(),
    );
  }

  private async expireUnpaidOrdersUnlocked(): Promise<void> {
    const now = Date.now();
    const cutoff = new Date(now - this.timeoutMinutes * 60_000);
    const pendingCutoff = new Date(now - this.pendingTimeoutMinutes * 60_000);
    const failedCutoff = new Date(now - this.failedTimeoutMinutes * 60_000);

    const stale = await this.prisma.order.findMany({
      where: {
        status: 'EN_ATTENTE',
        // Un paiement encaissé protège la commande, quel que soit le délai.
        Payment: { none: { status: 'SUCCESS' } },
        // Une commande programmée n'a pas la même urgence : la cliente peut
        // commander la veille pour un gâteau du lendemain. On ne l'expire que
        // si l'échéance elle-même est dépassée.
        AND: [
          {
            OR: [{ scheduledFor: null }, { scheduledFor: { lt: new Date() } }],
          },
          {
            OR: [
              // Aucun paiement initié → délai court (45 min).
              {
                createdAt: { lt: cutoff },
                Payment: { none: {} },
              },
              // Tentative(s) définitivement refusée(s), aucune en cours →
              // délai très court (10 min, fix S-6). Le prestataire a tranché :
              // attendre plus longtemps n'immobilise du stock que pour rien.
              {
                createdAt: { lt: failedCutoff },
                Payment: {
                  none: { status: 'PENDING' },
                  some: { status: { in: ['FAILED', 'CANCELLED'] } },
                },
              },
              // Paiement en attente de confirmation → délai long (6 h). En
              // mode MANUAL, le client a peut-être bien envoyé l'argent et
              // c'est la confirmation qui traîne.
              {
                createdAt: { lt: pendingCutoff },
                Payment: { some: { status: 'PENDING' } },
              },
            ],
          },
        ],
      },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
      take: OrderExpiryService.MAX_PER_RUN,
    });

    if (stale.length === 0) return;

    let expired = 0;
    for (const order of stale) {
      try {
        if (await this.lifecycle.expireUnpaidOrder(order.id)) expired++;
      } catch (err) {
        // Une commande qui résiste ne doit pas bloquer les suivantes.
        this.logger.error(
          `Expiration de la commande ${order.id} échouée : ${(err as Error).message}`,
        );
      }
    }

    this.logger.warn(
      `⏱️ ${expired}/${stale.length} commande(s) expirée(s) faute de paiement ` +
        `(seuils : ${this.timeoutMinutes} min sans paiement initié, ` +
        `${this.failedTimeoutMinutes} min après un refus définitif, ` +
        `${this.pendingTimeoutMinutes} min avec paiement en attente)`,
    );
  }
}
