import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { PlatformSettingsService } from './platform-settings.service';
import { MaintenanceGuard } from './guards/maintenance.guard';

/**
 * Lecture/écriture des réglages de plateforme, **sans les controllers**.
 *
 * `PlatformSettingsModule` expose deux controllers, dont
 * `PATCH /admin/platform-settings` — le barème de fidélité et le pourcentage
 * de frais de service. Les consommateurs internes (`LoyaltyModule`, le
 * calculateur de commande) n'ont besoin que du service.
 *
 * La séparation est ici la plus critique du lot : la chaîne
 * `worker → LoyaltyModule → PlatformSettingsModule` montait cette route
 * d'administration sur le port du worker, où aucun `APP_GUARD` n'est
 * enregistré. Elle y était donc modifiable **sans authentification**.
 */
@Module({
  imports: [PrismaModule],
  providers: [PlatformSettingsService, MaintenanceGuard],
  exports: [PlatformSettingsService, MaintenanceGuard],
})
export class PlatformSettingsCoreModule {}
