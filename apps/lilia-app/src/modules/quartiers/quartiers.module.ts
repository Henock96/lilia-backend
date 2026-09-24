import { Module } from '@nestjs/common';
import { QuartiersController } from './quartiers.controller';
import { QuartiersService } from './quartiers.service';
import { DeliveryZonesService } from './delivery-zones.service';
import { PrismaModule } from '../../prisma/prisma.module';
import { DeliveryPricingCoreModule } from '../delivery-pricing/delivery-pricing-core.module';

@Module({
  imports: [PrismaModule, DeliveryPricingCoreModule],
  controllers: [QuartiersController],
  providers: [QuartiersService, DeliveryZonesService],
  exports: [QuartiersService, DeliveryZonesService],
})
export class QuartiersModule {}
