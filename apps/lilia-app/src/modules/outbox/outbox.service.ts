import { Injectable, Logger } from '@nestjs/common';
import { OutboxEventStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Boîte d'envoi transactionnelle (fix H7 — audit du 28/08/2026).
 *
 * Écrire l'obligation de notifier **dans la même transaction** que la commande
 * est ce qui transforme « on a émis un événement en mémoire et on espère » en
 * « la commande existe, donc la notification est due ». Le dispatcher
 * (`OutboxDispatcherService`) se charge ensuite de la livrer, avec retry.
 */
@Injectable()
export class OutboxService {
  private readonly logger = new Logger(OutboxService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Enfile un événement DANS une transaction en cours.
   * Le client transactionnel est passé explicitement : c'est tout l'intérêt du
   * pattern — si la transaction rollback, l'obligation disparaît avec elle.
   */
  async enqueueInTransaction(
    tx: Prisma.TransactionClient,
    params: {
      type: string;
      aggregateId: string;
      payload: Prisma.InputJsonValue;
    },
  ): Promise<string> {
    const event = await tx.outboxEvent.create({
      data: {
        type: params.type,
        aggregateId: params.aggregateId,
        payload: params.payload,
      },
      select: { id: true },
    });
    return event.id;
  }

  /**
   * Acquitte un événement livré. Appelé par le listener en mémoire quand le
   * push est parti : le chemin rapide reste le chemin normal, le dispatcher
   * n'est qu'un filet.
   */
  async markSent(id: string): Promise<void> {
    await this.prisma.outboxEvent
      .updateMany({
        where: { id, status: OutboxEventStatus.PENDING },
        data: { status: OutboxEventStatus.SENT, processedAt: new Date() },
      })
      .catch((err) =>
        this.logger.error(
          `Acquittement outbox ${id} échoué : ${(err as Error).message}`,
        ),
      );
  }

  /** Événements en souffrance : PENDING, dus, et plus vieux que le délai de grâce. */
  async claimDue(params: { graceSeconds: number; batchSize: number }) {
    const now = new Date();
    const cutoff = new Date(now.getTime() - params.graceSeconds * 1000);

    return this.prisma.outboxEvent.findMany({
      where: {
        status: OutboxEventStatus.PENDING,
        nextAttemptAt: { lte: now },
        createdAt: { lte: cutoff },
      },
      orderBy: { createdAt: 'asc' },
      take: params.batchSize,
    });
  }

  /** Reporte une tentative avec un backoff exponentiel plafonné. */
  async scheduleRetry(id: string, attempts: number, error: string) {
    const delaySeconds = Math.min(2 ** attempts * 30, 15 * 60); // 30 s → 15 min
    await this.prisma.outboxEvent.update({
      where: { id },
      data: {
        attempts: attempts + 1,
        nextAttemptAt: new Date(Date.now() + delaySeconds * 1000),
        lastError: error.slice(0, 2000),
      },
    });
  }

  /** Abandon après épuisement des tentatives — la ligne reste pour enquête. */
  async markFailed(id: string, error: string) {
    await this.prisma.outboxEvent.update({
      where: { id },
      data: {
        status: OutboxEventStatus.FAILED,
        lastError: error.slice(0, 2000),
        processedAt: new Date(),
      },
    });
  }

  async markEscalated(id: string) {
    await this.prisma.outboxEvent.update({
      where: { id },
      data: { escalatedAt: new Date() },
    });
  }
}
