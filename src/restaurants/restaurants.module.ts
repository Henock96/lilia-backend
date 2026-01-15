import { Module } from '@nestjs/common';
import { RestaurantsService } from './restaurants.service';
import { RestaurantsController } from './restaurants.controller';
import { PrismaService } from 'src/prisma/prisma.service';
import { PaginationService } from 'src/common/pagination/pagination.service';

@Module({
  providers: [RestaurantsService, PrismaService, PaginationService],
  controllers: [RestaurantsController],
})
export class RestaurantsModule {}
