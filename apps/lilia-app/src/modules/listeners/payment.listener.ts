import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../../prisma/prisma.service';
import { OrderPaymentConfirmedEvent } from '../events/order-events';
import { ReferralService } from '../users/referral.service';

/**
 * Réactions à la confirmation / à l'échec d'un encaissement client.
 *
 * ⚠️ Ce listener ne fait **plus avancer la commande** (chantier pawaPay,
 * août 2026). Il notifiait le client puis forçait `PAYER → EN_PREPARATION`
 * avec un `order.update` inconditionnel :
 *
 *  - hors de la state machine, donc sans vérifier ni la transition ni l'acteur ;
 *  - sans le verrou optimiste `claimStatus` posé par le fix H6 — une annulation
 *    vendeur concurrente était donc écrasée, et la commande repartait en
 *    préparation alors que le stock avait été rendu ;
 *  - et surtout : **le vendeur n'acceptait jamais rien**. Il découvrait une
 *    commande déjà « en préparation ». Avec un encaissement manuel (plusieurs
 *    heures d'écart) le phénomène passait inaperçu ; avec pawaPay, qui confirme
 *    en une minute, il devenait systématique.
 *
 * Le passage `PAYER → EN_PREPARATION` est désormais un geste du vendeur
 * (`PATCH /orders/:id/status`), que la matrice de transitions autorise déjà et
 * que l'app d'administration propose déjà.
 *
 * La notification du **vendeur** ne part pas d'ici non plus : elle est portée
 * par l'`OutboxEvent` `order.paid`, écrit dans la transaction de confirmation
 * du paiement, donc garanti et rattrapable (avec escalade SMS).
 */
@Injectable()
export class PaymentListener {
  private readonly logger = new Logger(PaymentListener.name);

  constructor(
    private readonly notificationsService: NotificationsService,
    private readonly prisma: PrismaService,
    private readonly referral: ReferralService,
  ) {}

  @OnEvent('order.payment.confirmed')
  async handlePaymentConfirmed(event: OrderPaymentConfirmedEvent) {
    this.logger.log(
      `🎉 Paiement confirmé — commande ${event.orderId}, ${event.amount} ${event.currency}`,
    );

    try {
      const order = await this.prisma.order.findUnique({
        where: { id: event.orderId },
        select: {
          id: true,
          restaurant: { select: { nom: true } },
        },
      });

      if (!order) {
        this.logger.error(`Commande ${event.orderId} introuvable`);
        return;
      }

      // Un seul push client. Il y en avait deux — « Paiement confirmé » puis
      // « En préparation », émis à une seconde d'intervalle par l'auto-transition
      // supprimée ci-dessus. Le second annonçait de surcroît une préparation qui
      // n'avait pas commencé.
      await this.notifyCustomerPaymentSuccess(event, order.restaurant.nom);

      // Récompense de parrainage — versée ICI, et nulle part ailleurs (fix C3) :
      // elle l'était à la création de la commande, donc sans qu'un franc soit
      // payé. Non bloquant.
      await this.referral
        .rewardIfFirstPaidOrder(event.userId)
        .catch((err) =>
          this.logger.error(`Erreur récompense parrainage: ${err}`),
        );
    } catch (error) {
      this.logger.error(
        `Erreur au traitement de order.payment.confirmed : ${(error as Error).message}`,
        (error as Error).stack,
      );
    }
  }

  private async notifyCustomerPaymentSuccess(
    event: OrderPaymentConfirmedEvent,
    // ⚠️ `nom`, pas `name` : le champ Prisma s'appelle `nom`. La version
    // précédente lisait `order.restaurant.name`, donc `undefined` — le client
    // recevait littéralement « votre commande chez undefined ».
    vendorName: string,
  ) {
    await this.notificationsService.sendPushNotification(
      event.userId,
      '✅ Commande confirmée !',
      `Votre paiement de ${event.amount} ${event.currency} est confirmé. ${vendorName} a reçu votre commande.`,
      {
        orderId: event.orderId,
        paymentId: event.paymentId,
        type: 'payment_confirmed',
        amount: event.amount.toString(),
        currency: event.currency,
        restaurantId: event.restaurantId,
      },
    );

    this.logger.log(`📱 Push de confirmation envoyé au client ${event.userId}`);
  }

  @OnEvent('order.payment.failed')
  async handlePaymentFailed(event: {
    orderId: string;
    userId: string;
    paymentId: string;
    reason: string;
  }) {
    this.logger.warn(
      `❌ Paiement échoué — commande ${event.orderId} : ${event.reason}`,
    );

    try {
      const order = await this.prisma.order.findUnique({
        where: { id: event.orderId },
        select: { restaurant: { select: { nom: true } } },
      });
      if (!order) return;

      // ⚠️ `event.reason` n'est PAS un message client.
      //
      // Il vaut `failureMessage ?? failureCode`, c'est-à-dire le texte brut de
      // l'opérateur. Interpolé ici, il a réellement produit la notification :
      // « … n'a pas abouti : "Airtel_CG" did not specify a reason for this
      // faliure » — faute d'orthographe comprise.
      //
      // La notification ne dit donc plus la cause. Elle ramène le client dans
      // l'application, où `mapPaymentFailure` traduit le `failureCode` en une
      // phrase compréhensible. Une notification n'a de toute façon pas la place
      // d'expliquer, et se tromper d'explication coûte plus qu'un mot de moins.
      //
      // Le motif technique reste dans le journal (ligne ci-dessus), dans
      // `Payment.failureCode` / `failureMessage` et dans `PaymentEvent`.
      await this.notificationsService.sendPushNotification(
        event.userId,
        '❌ Paiement non abouti',
        `Le paiement de votre commande chez ${order.restaurant.nom} n'a pas pu ` +
          `être finalisé. Aucun montant n'a été prélevé — vous pouvez réessayer.`,
        {
          orderId: event.orderId,
          paymentId: event.paymentId,
          type: 'payment_failed',
        },
      );
    } catch (error) {
      this.logger.error(
        `Erreur au traitement de order.payment.failed : ${(error as Error).message}`,
      );
    }
  }

  @OnEvent('order.payment.timeout')
  async handlePaymentTimeout(event: {
    orderId: string;
    userId: string;
    paymentId: string;
  }) {
    this.logger.warn(`⏰ Paiement expiré — commande ${event.orderId}`);

    try {
      const order = await this.prisma.order.findUnique({
        where: { id: event.orderId },
        select: { restaurant: { select: { nom: true } } },
      });
      if (!order) return;

      await this.notificationsService.sendPushNotification(
        event.userId,
        '⏰ Délai de paiement expiré',
        `Le délai de paiement pour votre commande chez ${order.restaurant.nom} a expiré. Vous pouvez relancer le paiement.`,
        {
          orderId: event.orderId,
          paymentId: event.paymentId,
          type: 'payment_timeout',
        },
      );
    } catch (error) {
      this.logger.error(
        `Erreur au traitement de order.payment.timeout : ${(error as Error).message}`,
      );
    }
  }
}
