import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { PlatformSettingsCoreModule } from '../platform-settings/platform-settings-core.module';
import { LoyaltyService } from './loyalty.service';
import { LoyaltyReconciliationService } from './loyalty-reconciliation.service';

/**
 * Point d'entrée unique du crédit de points de fidélité (fix M5).
 * Importé par OrdersModule et DeliveriesModule — les deux chemins qui mènent
 * une commande à LIVRER.
 */
@Module({
  imports: [PrismaModule, PlatformSettingsCoreModule],
  providers: [
    LoyaltyService,
    // Porte un `@Cron` (réconciliation quotidienne) mais est aussi consommé
    // par `GET /admin/loyalty-drifts` : on le fournit toujours. Le cron
    // lui-même est inoffensif hors du worker — `CronLockService` garantit
    // qu'un seul processus l'exécute.
    LoyaltyReconciliationService,
  ],
  exports: [LoyaltyService, LoyaltyReconciliationService],
})
export class LoyaltyModule {}
