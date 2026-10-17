import { Module } from '@nestjs/common';
import { PlatformSettingsCoreModule } from '../platform-settings/platform-settings-core.module';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import { ReservationSettingsController } from './reservation-settings.controller';
import { ReservationSettingsService } from './reservation-settings.service';

/**
 * Premium (Lot 3) — configuration de la réservation sur place.
 *
 * Servi par l'API uniquement : il déclare un controller, il n'entre donc
 * jamais dans le graphe du worker (`worker.module.spec.ts`).
 */
@Module({
  imports: [PlatformSettingsCoreModule, SubscriptionsModule],
  controllers: [ReservationSettingsController],
  providers: [ReservationSettingsService],
})
export class ReservationsModule {}
