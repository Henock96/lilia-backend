import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';

import { NotificationsService } from '../notifications/notifications.service';
import {
  LoyaltyPointsEarnedEvent,
  ReferralRewardGrantedEvent,
} from '../events/loyalty-events';

/**
 * Notifications du programme de fidélité.
 *
 * Le programme était **entièrement silencieux** jusqu'à septembre 2026 : aucun
 * push n'annonçait un point gagné ni un filleul converti (audit du 06/09/2026,
 * D15). Un parrain n'avait donc aucun signal lui disant que son invitation
 * avait marché — donc aucune raison d'en envoyer une deuxième.
 *
 * ## Deux règles de construction
 *
 * 1. **Rien ici n'est dans une transaction financière.** Ce listener réagit à
 *    un crédit déjà écrit et validé. Un échec FCM se journalise, il n'annule
 *    rien.
 * 2. **Aucun montant n'est écrit en dur.** La valeur du point voyage dans
 *    l'événement, telle qu'elle était au moment du crédit. Le jour où le
 *    barème change, les messages suivent sans redéploiement.
 */
@Injectable()
export class LoyaltyListener {
  private readonly logger = new Logger(LoyaltyListener.name);

  constructor(private readonly notifications: NotificationsService) {}

  @OnEvent('loyalty.points.earned')
  async handlePointsEarned(event: LoyaltyPointsEarnedEvent): Promise<void> {
    const value = event.points * event.pointValueXaf;
    await this.notifications
      .sendPushNotification(
        event.userId,
        `⭐ +${event.points} point${event.points > 1 ? 's' : ''} de fidélité`,
        `Votre commande a été livrée. ${formatXaf(value)} de réduction sur une prochaine commande.`,
        {
          type: 'loyalty_earned',
          orderId: event.orderId,
          points: String(event.points),
        },
      )
      .catch((err: Error) =>
        this.logger.error(
          `Notification de fidélité non envoyée (user ${event.userId}) : ${err.message}`,
        ),
      );
  }

  @OnEvent('referral.reward.granted')
  async handleReferralGranted(
    event: ReferralRewardGrantedEvent,
  ): Promise<void> {
    // Seul le parrain est notifié : le filleul ne reçoit plus rien depuis la
    // refonte du programme, lui annoncer une récompense serait faux.
    await this.notifications
      .sendPushNotification(
        event.referrerId,
        '🎁 Votre filleul a passé sa première commande !',
        `Vous gagnez ${event.points} point${event.points > 1 ? 's' : ''} de fidélité. Merci d'avoir parlé de Lilia Food.`,
        {
          type: 'referral_reward',
          orderId: event.orderId,
          points: String(event.points),
        },
      )
      .catch((err: Error) =>
        this.logger.error(
          `Notification de parrainage non envoyée (parrain ${event.referrerId}) : ${err.message}`,
        ),
      );
  }
}

/**
 * Format monétaire congolais : séparateur de milliers en espace simple.
 *
 * `toLocaleString('fr-FR')` produit une espace **insécable étroite** (U+202F)
 * ou insécable (U+00A0) selon la version d'ICU. Les deux s'affichent mal dans
 * une notification push — et les écrire littéralement dans une expression
 * régulière poserait des caractères invisibles dans le source, que le lint
 * refuse à juste titre : on les désigne donc par leur point de code.
 */
const THOUSANDS_SEPARATORS = /[\u202F\u00A0]/g;

function formatXaf(amount: number): string {
  return `${amount.toLocaleString('fr-FR').replace(THOUSANDS_SEPARATORS, ' ')} FCFA`;
}
