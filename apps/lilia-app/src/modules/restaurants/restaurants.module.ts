import { Module } from '@nestjs/common';
import { RestaurantsService } from './restaurants.service';
import { RestaurantsController } from './restaurants.controller';
import { PrismaService } from '../../prisma/prisma.service';
import { PaginationService } from '../../common/pagination/pagination.service';

@Module({
  providers: [RestaurantsService, PrismaService, PaginationService],
  controllers: [RestaurantsController],
})
export class RestaurantsModule {}
