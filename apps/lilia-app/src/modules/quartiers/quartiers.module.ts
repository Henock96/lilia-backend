/* eslint-disable prettier/prettier */
import { Module } from '@nestjs/common';
import { QuartiersController } from './quartiers.controller';
import { QuartiersService } from './quartiers.service';
import { DeliveryZonesService } from './delivery-zones.service';
import { PrismaModule } from '../../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [QuartiersController],
  providers: [QuartiersService, DeliveryZonesService],
  exports: [QuartiersService, DeliveryZonesService],
})
export class QuartiersModule {}
