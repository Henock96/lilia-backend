import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { PaginationService } from '../../common/pagination/pagination.service';
import { IdempotencyService } from '../../common/idempotency/idempotency.service';
import { FirebaseModule } from '../firebase/firebase.module';
import { PhotosCommonModule } from '../photos-common/photos-common.module';
import { AdminAuditModule } from '../admin-audit/admin-audit.module';
import { RestaurantsModule } from '../restaurants/restaurants.module';
import { QuartiersModule } from '../quartiers/quartiers.module';
import { VendorsCoreModule } from './vendors-core.module';
import { DeliveryPricingCoreModule } from '../delivery-pricing/delivery-pricing-core.module';
import { VendorsController } from './vendors.controller';
import {
  AdminVendorOnboardingController,
  VendorOnboardingController,
} from './vendor-onboarding.controller';
import { VendorsService } from './vendors.service';
import {
  AdminPublicHolidaysController,
  VendorClosuresController,
} from './vendor-closures.controller';
import { VendorClosuresService } from './vendor-closures.service';
import { VendorOpeningService } from './vendor-opening.service';
import { PublicHolidaysService } from './public-holidays.service';
import { VendorOnboardingService } from './vendor-onboarding.service';
import { PreorderValidatorService } from './preorder-validator.service';
import { PlatformSettingsCoreModule } from '../platform-settings/platform-settings-core.module';

@Module({
  imports: [
    // F3-09 — interrupteur `modifiersEnabled` lu par la carte publique.
    PlatformSettingsCoreModule,
    PrismaModule,
    FirebaseModule,
    PhotosCommonModule,
    AdminAuditModule,
    RestaurantsModule,
    // Fournit VendorInvitationService et VendorReadinessService, tous deux
    // partagés avec le worker via OutboxModule.
    VendorsCoreModule,
    // Fournit DeliveryZonesService à `GET /vendors/:id/delivery-zones`.
    // QuartiersModule n'importe que PrismaModule : aucun cycle possible.
    QuartiersModule,
    // Simulateur de subvention de livraison (F3-02).
    DeliveryPricingCoreModule,
  ],
  controllers: [
    VendorsController,
    VendorOnboardingController,
    AdminVendorOnboardingController,
    // F3-03 — pause, congés, jours fériés.
    VendorClosuresController,
    AdminPublicHolidaysController,
  ],
  providers: [
    VendorsService,
    VendorOpeningService,
    VendorClosuresService,
    PublicHolidaysService,
    VendorOnboardingService,
    PreorderValidatorService,
    PaginationService,
    IdempotencyService,
  ],
  exports: [VendorsService, PreorderValidatorService, VendorOnboardingService],
})
export class VendorsModule {}
