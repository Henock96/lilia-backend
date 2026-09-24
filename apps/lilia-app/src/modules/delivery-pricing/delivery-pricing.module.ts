import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { DeliveryPricingCoreModule } from './delivery-pricing-core.module';
import { DeliveryTariffsService } from './delivery-tariffs.service';
import { AdminDeliveryTariffsController } from './admin-delivery-tariffs.controller';

/**
 * Administration de la grille de livraison (F3-02). Porte un controller :
 * réservé au processus web, jamais importé par le worker (qui n'a que le
 * module core).
 */
@Module({
  imports: [PrismaModule, DeliveryPricingCoreModule],
  controllers: [AdminDeliveryTariffsController],
  providers: [DeliveryTariffsService],
})
export class DeliveryPricingModule {}
