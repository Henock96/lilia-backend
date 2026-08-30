import { Module } from '@nestjs/common';
import { RestaurantsService } from './restaurants.service';
import { RestaurantAccessService } from './restaurant-access.service';
import { RestaurantQueryService } from './restaurant-query.service';
import { RestaurantHoursService } from './restaurant-hours.service';
import { RestaurantsController } from './restaurants.controller';
import { PrismaService } from '../../prisma/prisma.service';

@Module({
  providers: [
    RestaurantsService,
    RestaurantAccessService,
    RestaurantQueryService,
    RestaurantHoursService,
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
