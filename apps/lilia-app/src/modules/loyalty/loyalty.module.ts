import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { PlatformSettingsCoreModule } from '../platform-settings/platform-settings-core.module';
import { LoyaltyService } from './loyalty.service';
import { LoyaltyReconciliationService } from './loyalty-reconciliation.service';

/**
 * Point d'entrée unique du crédit de points de fidélité (fix M5).
 * Importé par OrdersModule et DeliveriesModule — les deux chemins qui mènent
 * une commande à LIVRER.
 *
 * ⚠️ Ce module est dans le graphe du **worker** (via `OrdersCoreModule`, tiré
 * par `AppScheduleModule`). Il ne doit donc contenir que ce qui a du sens sans
 * `AppModule` : `LoyaltyAdminService` en a été retiré et vit dans `AdminModule`,
 * parce qu'il dépend d'`AdminAuditService` — `@Global()`, mais global au seul
 * graphe qui le déclare, et le worker ne le déclare pas.
 *
 * Le processus compilait, les tests passaient, et le worker mourait au
 * bootstrap : « Nest can't resolve dependencies of the LoyaltyAdminService ».
 * Attrapé par `scripts/ci/boot-smoke.sh`, seul contrôle qui lève réellement
 * les binaires.
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
