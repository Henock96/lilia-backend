import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { PaginationService } from '../../common/pagination/pagination.service';
import { IdempotencyService } from '../../common/idempotency/idempotency.service';
import { FirebaseModule } from '../firebase/firebase.module';
import { PhotosCommonModule } from '../photos-common/photos-common.module';
import { RestaurantsModule } from '../restaurants/restaurants.module';
import { VendorsCoreModule } from './vendors-core.module';
import { VendorsController } from './vendors.controller';
import {
  AdminVendorOnboardingController,
  VendorOnboardingController,
} from './vendor-onboarding.controller';
import { VendorsService } from './vendors.service';
import { VendorOnboardingService } from './vendor-onboarding.service';
import { PreorderValidatorService } from './preorder-validator.service';

@Module({
  imports: [
    PrismaModule,
    FirebaseModule,
    PhotosCommonModule,
    RestaurantsModule,
    // Fournit VendorInvitationService et VendorReadinessService, tous deux
    // partagés avec le worker via OutboxModule.
    VendorsCoreModule,
  ],
  controllers: [
    VendorsController,
    VendorOnboardingController,
    AdminVendorOnboardingController,
  ],
  providers: [
    VendorsService,
    VendorOnboardingService,
    PreorderValidatorService,
    PaginationService,
    IdempotencyService,
  ],
  exports: [VendorsService, PreorderValidatorService, VendorOnboardingService],
})
export class VendorsModule {}
