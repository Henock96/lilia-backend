import { Module } from '@nestjs/common';
import { RestaurantsService } from './restaurants.service';
import { RestaurantAccessService } from './restaurant-access.service';
import { RestaurantQueryService } from './restaurant-query.service';
import { RestaurantHoursService } from './restaurant-hours.service';
import { RestaurantOpenStatusService } from './restaurant-open-status.service';
import { VendorOpeningService } from '../vendors/vendor-opening.service';
import { RestaurantsController } from './restaurants.controller';
import { PrismaService } from '../../prisma/prisma.service';
import { PlatformSettingsCoreModule } from '../platform-settings/platform-settings-core.module';

@Module({
  // F3-09 — interrupteur `modifiersEnabled` lu par la carte publique.
  imports: [PlatformSettingsCoreModule],
  providers: [
    RestaurantsService,
    RestaurantAccessService,
    RestaurantQueryService,
    RestaurantHoursService,
    RestaurantOpenStatusService,
    // Sans dépendance autre que Prisma : chaque module l'instancie (F3-03).
    VendorOpeningService,
    PrismaService,
  ],
  controllers: [RestaurantsController],
  // Le contrôle de propriété et la gestion des horaires servent aussi à
  // l'onboarding vendeur. Les exporter évite d'en écrire une seconde version :
  // deux implémentations d'une règle d'autorisation finissent toujours par
  // diverger, et c'est celle qu'on a oublié de corriger qui laisse passer.
  exports: [RestaurantAccessService, RestaurantHoursService],
})
export class RestaurantsModule {}
