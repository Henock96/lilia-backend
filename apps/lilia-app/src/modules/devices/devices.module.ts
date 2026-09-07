import { Module } from '@nestjs/common';

import { PrismaModule } from '../../prisma/prisma.module';
import { DeviceInstallationService } from './device-installation.service';

/**
 * Enregistrement des installations applicatives (signal anti-abus).
 *
 * ⚠️ Aucun `controllers` — et il ne doit jamais en avoir. Ce module est
 * consommé par `UsersModule`, lui-même dans le graphe de l'application web
 * comme dans celui du worker. Y déclarer un contrôleur monterait une route sur
 * le port du worker, **sans les `APP_GUARD` qui vivent dans `AppModule`** :
 * c'est exactement le défaut corrigé en août 2026 sur
 * `PATCH /admin/platform-settings`.
 */
@Module({
  imports: [PrismaModule],
  providers: [DeviceInstallationService],
  exports: [DeviceInstallationService],
})
export class DevicesModule {}
