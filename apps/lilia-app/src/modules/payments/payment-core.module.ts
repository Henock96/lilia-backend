import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { PrismaModule } from '../../prisma/prisma.module';
import { OutboxModule } from '../outbox/outbox.module';
import { PlatformSettingsCoreModule } from '../platform-settings/platform-settings-core.module';

import { PaymentService } from './services/payment.service';
import { PaymentEventService } from './services/payment-event.service';
import { RestaurantPayoutService } from './services/restaurant-payout.service';
import { MtnMomoService } from './services/mtn-momo.service';
import { MtnMomoTokenService } from './services/mtn-momo-token.service';

import { PaymentProviderRegistry } from './payment-provider.registry';
import { PayoutStateMachine } from './payout-state.machine';
import { ManualPaymentProvider } from './providers/manual.provider';
import { MtnMomoProvider } from './providers/mtn-momo.provider';
import { PawaPayProvider } from './providers/pawapay/pawapay.provider';
import { PawaPayHttpService } from './providers/pawapay/pawapay-http.service';
import { PawaPaySignatureService } from './providers/pawapay/pawapay-signature.service';

/**
 * Paiements et reversements — **sans aucun controller**.
 *
 * `PaymentModule` expose sept routes, dont `POST /payments/:id/confirm` et
 * `POST /admin/orders/:id/payout` : décider qu'une commande est payée, et
 * envoyer de l'argent à un vendeur.
 *
 * Or NestJS monte les controllers de **tous** les modules du graphe, et les
 * `APP_GUARD` (authentification, rôles, throttling) vivent dans `AppModule` /
 * `AuthModule`, que le worker n'importe pas. La chaîne
 * `worker → AppScheduleModule → PaymentModule` aurait donc exposé le
 * déclenchement de reversements **sans authentification** sur le port du worker
 * — exactement le défaut trouvé le 29/08/2026 sur `PATCH /admin/platform-settings`.
 *
 * D'où ce module : les consommateurs internes (crons de réconciliation) prennent
 * les services, jamais les routes.
 *
 * ⚠️ **Règle** : un module `*-core` ne déclare jamais de `controllers`, ni
 * n'importe un module qui en déclare. `worker.module.spec.ts` parcourt le graphe
 * et échoue en nommant le module fautif.
 */
@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    OutboxModule,
    PlatformSettingsCoreModule,
  ],
  providers: [
    ManualPaymentProvider,
    MtnMomoProvider,
    PawaPayProvider,
    PawaPayHttpService,
    PawaPaySignatureService,
    MtnMomoTokenService,
    MtnMomoService,
    PaymentProviderRegistry,
    PaymentService,
    PaymentEventService,
    RestaurantPayoutService,
    PayoutStateMachine,
  ],
  exports: [
    PaymentService,
    PaymentEventService,
    RestaurantPayoutService,
    PaymentProviderRegistry,
    PawaPayHttpService,
    PawaPaySignatureService,
    PayoutStateMachine,
  ],
})
export class PaymentCoreModule {}
