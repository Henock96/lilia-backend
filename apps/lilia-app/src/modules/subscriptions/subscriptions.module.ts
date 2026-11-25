import { Module } from '@nestjs/common';
import {
  AdminSubscriptionPaymentsController,
  AdminVendorSubscriptionsController,
  VendorSubscriptionController,
} from './subscriptions.controller';
import { SubscriptionsCoreModule } from './subscriptions-core.module';

/**
 * Premium (Lot 2) — abonnements vendeur.
 *
 * Servi par l'API uniquement : il déclare des controllers, il n'entre donc
 * jamais dans le graphe du worker (`worker.module.spec.ts`). La logique vit
 * dans `SubscriptionsCoreModule` (sans controller), réexporté ici pour les
 * modules qui lisent le droit (statistiques, réservations, vendeurs).
 */
@Module({
  imports: [SubscriptionsCoreModule],
  controllers: [
    AdminVendorSubscriptionsController,
    VendorSubscriptionController,
    // Premium S1 — paiements pawaPay d'abonnement (lecture).
    AdminSubscriptionPaymentsController,
  ],
  exports: [SubscriptionsCoreModule],
})
export class SubscriptionsModule {}
