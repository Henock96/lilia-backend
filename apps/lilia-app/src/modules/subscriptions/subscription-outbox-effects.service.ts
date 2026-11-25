import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OutboxEvent } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { EmailService } from '../email/email.service';
import { NotificationsService } from '../notifications/notifications.service';
import { OutboxDispatcherService } from '../outbox/outbox-dispatcher.service';
import {
  SUBSCRIPTION_ACTIVATED_EVENT,
  SUBSCRIPTION_EXPIRING_EVENT,
} from '../outbox/outbox-events';
import { OutboxService } from '../outbox/outbox.service';

const DATE_FR = new Intl.DateTimeFormat('fr-FR', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: 'Africa/Brazzaville',
});

/**
 * Premium S1 — avis au vendeur, dépilés par l'outbox (règle 11) : mois
 * ouverts après un paiement, et échéance qui approche (J-3, J0).
 *
 * Deux canaux, comme les alertes d'exploitation : le push (rapide) et
 * l'e-mail (qui existe toujours — le vendeur paie depuis l'admin web, qui
 * n'enregistre aucun jeton FCM). L'obligation est acquittée même si aucun
 * canal ne passe : un avis n'est pas un droit, et le rejouer à l'infini ne
 * changerait rien à un compte sans jeton ni e-mail.
 */
@Injectable()
export class SubscriptionOutboxEffectsService implements OnModuleInit {
  private readonly logger = new Logger(SubscriptionOutboxEffectsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
    private readonly dispatcher: OutboxDispatcherService,
    private readonly notifications: NotificationsService,
    private readonly email: EmailService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    this.dispatcher.registerHandler(SUBSCRIPTION_ACTIVATED_EVENT, (e) =>
      this.dispatchActivated(e),
    );
    this.dispatcher.registerHandler(SUBSCRIPTION_EXPIRING_EVENT, (e) =>
      this.dispatchExpiring(e),
    );
  }

  async dispatchActivated(event: OutboxEvent): Promise<void> {
    const { subscriptionPaymentId } = event.payload as {
      subscriptionPaymentId: string;
    };
    const payment = await this.prisma.subscriptionPayment.findUnique({
      where: { id: subscriptionPaymentId },
      select: {
        months: true,
        amountXaf: true,
        reference: true,
        restaurantId: true,
        subscriptions: { select: { endsAt: true } },
      },
    });
    if (!payment) {
      this.logger.error(
        `Avis Premium : paiement ${subscriptionPaymentId} introuvable — acquitté sans envoi.`,
      );
      await this.outbox.markSent(event.id);
      return;
    }
    const paidUntil = payment.subscriptions.reduce<Date | null>(
      (max, s) => (max == null || s.endsAt > max ? s.endsAt : max),
      null,
    );
    const until = paidUntil ? DATE_FR.format(paidUntil) : '—';
    await this.notifyOwner(payment.restaurantId, {
      title: '👑 Premium activé',
      body: `${payment.months} mois payés (${payment.amountXaf} FCFA, réf. ${payment.reference}). Premium jusqu'au ${until}.`,
      subject: `Votre abonnement Premium est actif jusqu'au ${until}`,
    });
    await this.outbox.markSent(event.id);
  }

  async dispatchExpiring(event: OutboxEvent): Promise<void> {
    const p = event.payload as {
      restaurantId: string;
      paidUntil: string;
      tier: 'J3' | 'J0';
    };
    const until = DATE_FR.format(new Date(p.paidUntil));
    await this.notifyOwner(p.restaurantId, {
      title:
        p.tier === 'J0'
          ? '👑 Votre Premium se termine aujourd’hui'
          : '👑 Votre Premium se termine bientôt',
      body: `Premium jusqu'au ${until}. Renouvelez depuis votre espace Lilia pour garder vos réservations et vos statistiques.`,
      subject: `Votre abonnement Premium se termine le ${until}`,
    });
    await this.outbox.markSent(event.id);
  }

  private async notifyOwner(
    restaurantId: string,
    message: { title: string; body: string; subject: string },
  ): Promise<void> {
    const vendor = await this.prisma.restaurant.findUnique({
      where: { id: restaurantId },
      select: {
        nom: true,
        owner: { select: { id: true, email: true, nom: true } },
      },
    });
    if (!vendor?.owner) {
      this.logger.warn(
        `Avis Premium : boutique ${restaurantId} sans propriétaire.`,
      );
      return;
    }
    const base = this.config.get<string>('ADMIN_WEB_URL');
    const href = base ? `${base.replace(/\/$/, '')}/premium` : null;

    await this.notifications
      .sendPushNotification(vendor.owner.id, message.title, message.body, {
        type: 'subscription_update',
        restaurantId,
      })
      .catch((error: unknown) =>
        this.logger.warn(
          `Push Premium non parti (${restaurantId}) : ${(error as Error).message}`,
        ),
      );

    if (vendor.owner.email) {
      const sent = await this.email.sendEmail({
        to: vendor.owner.email,
        subject: message.subject,
        html:
          `<p>Bonjour ${escapeHtml(vendor.owner.nom ?? vendor.nom)},</p>` +
          `<p>${escapeHtml(message.body)}</p>` +
          (href
            ? `<p><a href="${href}">Ouvrir mon espace Premium</a></p>`
            : '') +
          '<p>L’équipe Lilia Food</p>',
      });
      if (!sent) {
        this.logger.warn(`E-mail Premium non parti (${restaurantId}).`);
      }
    }
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
