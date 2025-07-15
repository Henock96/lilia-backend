import { Module } from '@nestjs/common';
import { RestaurantsService } from './restaurants.service';
import { RestaurantsController } from './restaurants.controller';
import { PrismaService } from 'src/prisma/prisma.service';

@Module({
  providers: [RestaurantsService, PrismaService],
  controllers: [RestaurantsController],
})
export class RestaurantsModule {}
