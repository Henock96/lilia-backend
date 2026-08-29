import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { PlatformSettingsModule } from '../platform-settings/platform-settings.module';
import { LoyaltyService } from './loyalty.service';
import { LoyaltyReconciliationService } from './loyalty-reconciliation.service';

/**
 * Point d'entrée unique du crédit de points de fidélité (fix M5).
 * Importé par OrdersModule et DeliveriesModule — les deux chemins qui mènent
 * une commande à LIVRER.
 */
@Module({
  imports: [PrismaModule, PlatformSettingsModule],
  providers: [LoyaltyService, LoyaltyReconciliationService],
  exports: [LoyaltyService, LoyaltyReconciliationService],
})
export class LoyaltyModule {}
