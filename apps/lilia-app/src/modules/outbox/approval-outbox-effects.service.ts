import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { OutboxEvent } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { OutboxService } from './outbox.service';
import { OutboxDispatcherService } from './outbox-dispatcher.service';
import { APPROVAL_REQUESTED_EVENT } from './outbox-events';

/**
 * F3-08 — un geste financier attend un second administrateur : on le dit aux
 * AUTRES administrateurs porteurs de `FINANCE_APPROVE`. Une demande que
 * personne ne voit expire en silence au bout de 24 h — c'est tout le risque
 * des 4 yeux.
 */
@Injectable()
export class ApprovalOutboxEffectsService implements OnModuleInit {
  private readonly logger = new Logger(ApprovalOutboxEffectsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
    private readonly dispatcher: OutboxDispatcherService,
    private readonly notifications: NotificationsService,
  ) {}

  onModuleInit(): void {
    this.dispatcher.registerHandler(APPROVAL_REQUESTED_EVENT, (e) =>
      this.dispatchRequested(e),
    );
  }

  async dispatchRequested(event: OutboxEvent): Promise<void> {
    const p = event.payload as unknown as {
      approvalId: string;
      requestedBy: string;
      summary: string;
    };
    const approvers = await this.prisma.user.findMany({
      where: {
        role: 'ADMIN',
        id: { not: p.requestedBy },
        adminCapabilities: { has: 'FINANCE_APPROVE' },
        statusUser: 'ACTIVE',
      },
      select: { id: true },
    });
    if (approvers.length === 0) {
      // Personne pour approuver : la demande expirera. On le dit fort.
      this.logger.error(
        `🔐 Demande ${p.approvalId} sans second administrateur disponible : elle expirera.`,
      );
    }
    for (const admin of approvers) {
      await this.notifications
        .sendPushNotification(
          admin.id,
          '🔐 Approbation demandée',
          `${p.summary}. Un second administrateur doit valider.`,
          { type: 'approval_requested', approvalId: p.approvalId },
        )
        .catch((error) =>
          this.logger.warn(
            `Push d'approbation non parti vers ${admin.id} : ${(error as Error).message}`,
          ),
        );
    }
    await this.outbox.markSent(event.id);
  }
}
