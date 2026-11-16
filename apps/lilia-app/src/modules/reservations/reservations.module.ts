import { Module } from '@nestjs/common';
import { OrdersModule } from '../orders/orders.module';
import { PlatformSettingsCoreModule } from '../platform-settings/platform-settings-core.module';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import {
  ReservationAvailabilityController,
  ReservationsController,
} from './reservation-booking.controller';
import { ReservationBookingService } from './reservation-booking.service';
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
  imports: [PlatformSettingsCoreModule, SubscriptionsModule, OrdersModule],
  controllers: [
    ReservationSettingsController,
    ReservationAvailabilityController,
    ReservationsController,
    VendorReservationsController,
  ],
  providers: [
    ReservationSettingsService,
    ReservationBookingService,
    ReservationVendorService,
  ],
})
export class ReservationsModule {}
