import { Module } from '@nestjs/common';
import { PlatformSettingsCoreModule } from '../platform-settings/platform-settings-core.module';
import {
  AdminVendorSubscriptionsController,
  VendorSubscriptionController,
} from './subscriptions.controller';
import { VendorSubscriptionService } from './vendor-subscription.service';

/**
 * Premium (Lot 2) — abonnements vendeur.
 *
 * Servi par l'API uniquement : il déclare des controllers, il n'entre donc
 * jamais dans le graphe du worker (`worker.module.spec.ts`). Le service est
 * exporté pour les lots suivants (garde des statistiques, réservations).
 */
@Module({
  imports: [PlatformSettingsCoreModule],
  controllers: [
    AdminVendorSubscriptionsController,
    VendorSubscriptionController,
  ],
  providers: [VendorSubscriptionService],
  exports: [VendorSubscriptionService],
})
export class SubscriptionsModule {}
