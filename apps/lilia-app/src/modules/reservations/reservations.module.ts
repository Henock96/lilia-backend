import { Module } from '@nestjs/common';
import { OrdersModule } from '../orders/orders.module';
import { PlatformSettingsCoreModule } from '../platform-settings/platform-settings-core.module';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import {
  ReservationAvailabilityController,
  ReservationsController,
} from './reservation-booking.controller';
import { AdminReservationsController } from './admin-reservations.controller';
import { AdminReservationNoShowsController } from './admin-reservation-no-shows.controller';
import { ApprovalsModule } from '../approvals/approvals.module';
import { NoShowPayoutCoreModule } from './no-show-payout-core.module';
import { ReservationAdminService } from './reservation-admin.service';
import { ReservationBookingService } from './reservation-booking.service';
import { ReservationOrderService } from './reservation-order.service';
import { ReservationPaymentService } from './reservation-payment.service';
import { PaymentCoreModule } from '../payments/payment-core.module';
import { ReservationsCoreModule } from './reservations-core.module';
import { ReservationSettingsController } from './reservation-settings.controller';
import { ReservationSettingsService } from './reservation-settings.service';
import { ReservationVendorService } from './reservation-vendor.service';
import { VendorReservationsController } from './vendor-reservations.controller';

/**
 * Réservation sur place : configuration (Premium Lot 3), parcours client et
 * gestion vendeur (Lot 4).
 *
 * Servi par l'API uniquement : il déclare des controllers, il n'entre donc
 * jamais dans le graphe du worker (`worker.module.spec.ts`). Ce que le worker
 * exécute vit dans `ReservationsCoreModule` (sans controller).
 */
@Module({
  imports: [
    PlatformSettingsCoreModule,
    SubscriptionsModule,
    OrdersModule,
    ReservationsCoreModule,
    // 4B-2 — l'encaissement de la précommande (services seuls, sans route).
    PaymentCoreModule,
    // J6b — part d'une absence : demande (approbation) et liste.
    NoShowPayoutCoreModule,
    ApprovalsModule,
  ],
  controllers: [
    ReservationSettingsController,
    ReservationAvailabilityController,
    ReservationsController,
    VendorReservationsController,
    // J6 — annulation par le support (I-10).
    AdminReservationsController,
    // J6b — parts d'absence dues aux restaurants.
    AdminReservationNoShowsController,
  ],
  providers: [
    ReservationSettingsService,
    ReservationBookingService,
    ReservationVendorService,
    ReservationOrderService,
    ReservationPaymentService,
    ReservationAdminService,
  ],
})
export class ReservationsModule {}
