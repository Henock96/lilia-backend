import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';

import { PrismaService } from '../../prisma/prisma.service';
import { CronLockService } from '../../common/locks/cron-lock.service';

/**
 * Rétention des positions GPS de livraison.
 *
 * `DeliveryLocation` grossit d'une ligne par minute et par course, sans
 * qu'aucun mécanisme ne la purge : à 500 commandes/jour, c'est environ
 * 15 000 lignes quotidiennes conservées indéfiniment. La table n'est lue que
 * pendant la course (tracking temps réel) et, marginalement, pour reconstituer
 * un trajet en cas de litige.
 *
 * On garde donc une fenêtre courte mais utile — 30 jours par défaut, le temps
 * qu'un litige remonte — et on supprime au-delà.
 *
 * Trois précautions :
 *  - **par lots** : un `DELETE` unique sur des centaines de milliers de lignes
 *    prend un verrou long sur la table pendant que des livreurs y écrivent ;
 *  - **seulement sur les courses terminées** : une course encore active garde
 *    tout son historique, quelle que soit sa durée ;
 *  - **verrou distribué** : ce job ne doit pas tourner deux fois en parallèle.
 */
@Injectable()
export class TrackingRetentionService {
  private readonly logger = new Logger(TrackingRetentionService.name);

  /** Nombre de lignes supprimées par lot. */
  private static readonly BATCH_SIZE = 5_000;
  /** Garde-fou : au-delà, on s'arrête et on reprendra demain. */
  private static readonly MAX_BATCHES = 20;

  private readonly retentionDays: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly cronLock: CronLockService,
  ) {
    this.retentionDays =
      this.config.get<number>('TRACKING_RETENTION_DAYS') ?? 30;
  }

  /** 3 h UTC (4 h à Brazzaville) — hors des heures de commande. */
  @Cron('0 3 * * *', { name: 'tracking-retention' })
  async purgeOldPositions(): Promise<void> {
    await this.cronLock.runExclusively('tracking-retention', 900, () =>
      this.purge(),
    );
  }

  private async purge(): Promise<void> {
    const cutoff = new Date(
      Date.now() - this.retentionDays * 24 * 60 * 60 * 1000,
    );

    let totalDeleted = 0;

    for (let batch = 0; batch < TrackingRetentionService.MAX_BATCHES; batch++) {
      // `IN (SELECT … LIMIT n)` plutôt qu'un `deleteMany` global : on borne la
      // durée du verrou pour ne pas bloquer les écritures de position des
      // courses en cours.
      const deleted = await this.prisma.$executeRaw`
        DELETE FROM "DeliveryLocation"
         WHERE id IN (
           SELECT dl.id
             FROM "DeliveryLocation" dl
             JOIN "Delivery" d ON d.id = dl."deliveryId"
            WHERE dl."recordedAt" < ${cutoff}
              AND d.status IN ('LIVRER', 'ECHEC')
            LIMIT ${TrackingRetentionService.BATCH_SIZE}
         )
      `;

      totalDeleted += deleted;
      if (deleted < TrackingRetentionService.BATCH_SIZE) break;
    }

    if (totalDeleted > 0) {
      this.logger.log(
        `🧹 ${totalDeleted} position(s) GPS purgée(s) (antérieures au ${cutoff.toISOString().slice(0, 10)}, courses terminées).`,
      );
    }
  }
}
