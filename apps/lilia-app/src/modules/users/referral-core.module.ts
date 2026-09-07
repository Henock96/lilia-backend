import { Module } from '@nestjs/common';

import { PrismaModule } from '../../prisma/prisma.module';
import { PlatformSettingsCoreModule } from '../platform-settings/platform-settings-core.module';
import { DevicesModule } from '../devices/devices.module';
import { ReferralService } from './referral.service';
import { ReferralRiskService } from './referral-risk.service';

/**
 * Récompense de parrainage, **sans controller ni dépendance HTTP**.
 *
 * Il existe parce que le déclencheur a migré du paiement vers la livraison
 * (septembre 2026) : `ReferralService` est désormais consommé par
 * `OrderLifecycleService` et `DeliveriesService`, donc par `OrdersCoreModule`,
 * qui est dans le graphe du **worker**.
 *
 * Importer `UsersModule` depuis là y aurait monté `UsersController` — dont
 * `DELETE /users/me` — sur le port du worker, sans les `APP_GUARD` déclarés
 * dans `AppModule` / `AuthModule`. C'est le défaut exact corrigé en août 2026,
 * et `worker.module.spec.ts` échouerait en le nommant.
 *
 * Règle : **ne jamais déclarer de `controllers` ici, ni importer un module qui
 * en déclare.**
 */
@Module({
  imports: [PrismaModule, PlatformSettingsCoreModule, DevicesModule],
  providers: [ReferralService, ReferralRiskService],
  exports: [ReferralService, ReferralRiskService, DevicesModule],
})
export class ReferralCoreModule {}
