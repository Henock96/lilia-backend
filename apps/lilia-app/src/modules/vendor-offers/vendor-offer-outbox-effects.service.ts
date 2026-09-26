import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { OutboxEvent } from '@prisma/client';

import { NotificationsService } from '../notifications/notifications.service';
import { OutboxDispatcherService } from '../outbox/outbox-dispatcher.service';
import { VENDOR_OFFER_NOTICE_EVENT } from '../outbox/outbox-events';
import { OutboxService } from '../outbox/outbox.service';
import type { VendorOfferNoticePayload } from './vendor-offers.service';

const fcfa = (n: number) => `${Math.round(n).toLocaleString('fr-FR')} FCFA`;

/**
 * Prévient le vendeur de ce qui arrive à son offre sans son geste (F3-11) :
 * budget à 80 %, épuisé, échéance, arrêt par l'administration.
 *
 * Dépilé par l'outbox : ces changements sont constatés par le checkout (web)
 * et par le cron d'échéance (worker), qui n'a aucun écouteur en mémoire.
 */
@Injectable()
export class VendorOfferOutboxEffectsService implements OnModuleInit {
  private readonly logger = new Logger(VendorOfferOutboxEffectsService.name);

  constructor(
    private readonly outbox: OutboxService,
    private readonly dispatcher: OutboxDispatcherService,
    private readonly notifications: NotificationsService,
  ) {}

  onModuleInit(): void {
    this.dispatcher.registerHandler(VENDOR_OFFER_NOTICE_EVENT, (e) =>
      this.dispatch(e),
    );
  }

  async dispatch(event: OutboxEvent): Promise<void> {
    const p = event.payload as unknown as VendorOfferNoticePayload;
    const { title, body } = noticeText(p);
    await this.notifications.sendPushNotification(p.ownerId, title, body, {
      type: 'vendor_offer',
      offerId: p.offerId,
      notice: p.notice,
    });
    await this.outbox.markSent(event.id);
    this.logger.log(
      `📱 Vendeur ${p.ownerId} prévenu (${p.notice}) — offre ${p.offerId}`,
    );
  }
}

export function noticeText(p: VendorOfferNoticePayload): {
  title: string;
  body: string;
} {
  switch (p.notice) {
    case 'BUDGET_WARNING':
      return {
        title: '🏷️ Budget de votre offre à 80 %',
        body: `« ${p.label} » a consommé ${fcfa(p.spentXaf)} sur ${fcfa(p.budgetXaf)}. Elle s’arrêtera d’elle-même une fois le budget atteint.`,
      };
    case 'EXHAUSTED':
      return {
        title: '🏷️ Budget de votre offre épuisé',
        body: `« ${p.label} » a atteint son budget de ${fcfa(p.budgetXaf)} et n’est plus appliquée. Vous pouvez en publier une nouvelle.`,
      };
    case 'ENDED':
      return {
        title: '🏷️ Votre offre est terminée',
        body: `« ${p.label} » est arrivée à échéance (${fcfa(p.spentXaf)} offerts à vos clients).`,
      };
    case 'STOPPED':
      return {
        title: '⚠️ Votre offre a été arrêtée',
        body: `Lilia Food a arrêté « ${p.label} »${p.reason ? ` : ${p.reason}` : '.'}`,
      };
  }
}
