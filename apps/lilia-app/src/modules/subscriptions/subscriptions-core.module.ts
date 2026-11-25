import { Module } from '@nestjs/common';

import { PrismaModule } from '../../prisma/prisma.module';
import { EmailModule } from '../email/email.module';
import { NotificationsCoreModule } from '../notifications/notifications-core.module';
import { PaymentCoreModule } from '../payments/payment-core.module';
import { PlatformSettingsCoreModule } from '../platform-settings/platform-settings-core.module';
import { SubscriptionOutboxEffectsService } from './subscription-outbox-effects.service';
import { SubscriptionPaymentService } from './subscription-payment.service';
import { VendorSubscriptionService } from './vendor-subscription.service';

/**
 * Premium — logique des abonnements, **sans controller**.
 *
 * Chargé par le web (via `SubscriptionsModule`, qui ajoute les routes, et
 * `PaymentModule`, dont le webhook aiguille les dépôts d'abonnement) ET par le
 * worker (via `AppScheduleModule` : réconciliation, rappels, avis outbox).
 * Comme tout module « core », il ne déclare aucun controller et n'importe
 * aucun module qui en déclare (`worker.module.spec.ts`).
 */
@Module({
  imports: [
    PrismaModule,
    PlatformSettingsCoreModule,
    PaymentCoreModule,
    NotificationsCoreModule,
    EmailModule,
  ],
  providers: [
    VendorSubscriptionService,
    SubscriptionPaymentService,
    SubscriptionOutboxEffectsService,
  ],
  exports: [VendorSubscriptionService, SubscriptionPaymentService],
})
export class SubscriptionsCoreModule {}
