import { Module } from '@nestjs/common';

import { AdminAuditModule } from '../admin-audit/admin-audit.module';
import { PaymentCoreModule } from './payment-core.module';
import { RefundsCoreModule } from '../refunds/refunds-core.module';
// Variante **sans controllers** : importer `PlatformSettingsModule` monterait
// `PATCH /admin/platform-settings` une seconde fois. Voir le commentaire de
// `platform-settings-core.module.ts`.
import { PlatformSettingsCoreModule } from '../platform-settings/platform-settings-core.module';

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
import { VendorEarningsController } from './controllers/vendor-earnings.controller';
import { VendorEarningsService } from './services/vendor-earnings.service';

import { ApprovalsModule } from '../approvals/approvals.module';
@Module({
  // ⚠️ `RefundsCoreModule` est ici parce que `PawaPayWebhookController` aiguille
  // les callbacks de virement sortant vers DEUX tables : reversement vendeur et
  // remboursement client. pawaPay ne les distingue pas — il ne connaît qu'un
  // `payoutId` — donc c'est nous qui tranchons, et il nous faut les deux
  // services.
  //
  // Pas de cycle : `RefundsCoreModule → PaymentCoreModule`, que ce module
  // importe déjà par ailleurs, et `PaymentCoreModule` n'importe rien des
  // remboursements. `RefundsCoreModule` ne déclare aucun controller, la
  // frontière du worker reste donc intacte.
  //
  // ⚠️ **Aucun test unitaire ne pouvait attraper cet oubli.** Le spec du
  // controller monte un `Test.createTestingModule` avec ses providers listés à
  // la main : il prouve que la classe sait faire, jamais que Nest sait la
  // construire. C'est `scripts/ci/boot-smoke.sh` qui l'a vu, en levant
  // réellement le binaire — « un binaire qui compile n'est pas un binaire qui
  // démarre ».
  imports: [
    PaymentCoreModule,
    RefundsCoreModule,
    AdminAuditModule,
    PlatformSettingsCoreModule,
    // F3-08 — le changement de numéro de versement ouvre une demande.
    ApprovalsModule,
  ],
  controllers: [
    PaymentController,
    AdminPayoutController,
    WebhookController,
    PawaPayWebhookController,
    // F3-07 — « Mes gains » du vendeur.
    VendorEarningsController,
  ],
  providers: [VendorEarningsService],
  exports: [PaymentCoreModule],
})
export class PaymentModule {}
