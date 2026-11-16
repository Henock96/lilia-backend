import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { OutboxEvent } from '@prisma/client';

import { NotificationsService } from '../notifications/notifications.service';
import { OutboxDispatcherService } from '../outbox/outbox-dispatcher.service';
import { RESERVATION_NOTICE_EVENT } from '../outbox/outbox-events';
import { OutboxService } from '../outbox/outbox.service';
import {
  ReservationNoticePayload,
  reservationNoticeText,
} from './reservation-notices';

/**
 * Lot 4 — prévient le client ou le restaurant de ce qui arrive à une
 * réservation. Dépilé par l'outbox, chargé par le web ET par le worker : les
 * expirations et rappels sont constatés par un cron, sans écouteur en mémoire.
 *
 * Les apps installées ne connaissent pas `reservation_update` : leurs routeurs
 * (`notification_router.dart`, client et vendeurs) rendent « aucune action »
 * pour un payload sans `orderId` — le push s'affiche, rien ne s'ouvre.
 */
@Injectable()
export class ReservationOutboxEffectsService implements OnModuleInit {
  private readonly logger = new Logger(ReservationOutboxEffectsService.name);

  constructor(
    private readonly outbox: OutboxService,
    private readonly dispatcher: OutboxDispatcherService,
    private readonly notifications: NotificationsService,
  ) {}

  onModuleInit(): void {
    this.dispatcher.registerHandler(RESERVATION_NOTICE_EVENT, (e) =>
      this.dispatch(e),
    );
  }

  /**
   * N'acquitte que si **au moins un appareil** a reçu le push. Sans appareil
   * atteint (aucun jeton FCM, Firebase indisponible, tous les envois en
   * échec), l'erreur remonte au dispatcher : nouvelle tentative avec backoff,
   * puis `FAILED` — une trace visible, au lieu d'un `SENT` mensonger (revue
   * « échecs silencieux » du 18/10). Un restaurant qui ne reçoit jamais la
   * demande serait sinon indiscernable d'un restaurant qui l'ignore.
   */
  async dispatch(event: OutboxEvent): Promise<void> {
    const p = event.payload as unknown as ReservationNoticePayload;
    const { title, body } = reservationNoticeText(p);
    const result = await this.notifications.sendPushToUsers(
      [p.recipientUserId],
      title,
      body,
      p.notice === 'DAILY_SUMMARY'
        ? { type: 'reservation_daily_summary', date: p.date ?? '' }
        : {
            type: 'reservation_update',
            reservationId: p.reservationId ?? '',
            notice: p.notice,
          },
    );
    if (result.sent === 0) {
      throw new Error(
        `Réservation ${p.reservationId ?? p.date ?? ''} : avis ${p.notice} à ${p.audience} ${p.recipientUserId} non remis (${result.devices} appareil(s) connu(s), ${result.failed} échec(s))`,
      );
    }
    await this.outbox.markSent(event.id);
    this.logger.log(
      `📱 Réservation : ${p.notice} → ${p.audience} ${p.recipientUserId} (${result.sent}/${result.devices})`,
    );
  }
}
