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
})
export class RestaurantsModule {}
