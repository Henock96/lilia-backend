import { Module } from '@nestjs/common';

import { AdminAuditModule } from '../admin-audit/admin-audit.module';
import { PaymentCoreModule } from './payment-core.module';

import { PaymentController } from './controllers/payment.controller';
import { AdminPayoutController } from './controllers/admin-payout.controller';
import { WebhookController } from './controllers/webhook.controller';
import { PawaPayWebhookController } from './controllers/pawapay-webhook.controller';

/**
 * Façade HTTP des paiements : encaissement client (collection) et reversement
 * vendeur (payout).
 *
 * Toute la logique vit dans `PaymentCoreModule` ; ce module n'ajoute que les
 * quatre controllers, et n'est donc jamais importé par le worker.
 *
 * Les deux flux ne se déclenchent pas l'un l'autre : `RestaurantPayoutService`
 * n'est appelé que depuis `AdminPayoutController`, sur une action humaine
 * explicite.
 */
@Module({
  imports: [PaymentCoreModule, AdminAuditModule],
  controllers: [
    PaymentController,
    AdminPayoutController,
    WebhookController,
    PawaPayWebhookController,
  ],
  exports: [PaymentCoreModule],
})
export class PaymentModule {}
