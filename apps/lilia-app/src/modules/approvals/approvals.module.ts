import { Module } from '@nestjs/common';

import { AdminAuditModule } from '../admin-audit/admin-audit.module';
import { AuthModule } from '../auth/auth.module';
import { PlatformSettingsCoreModule } from '../platform-settings/platform-settings-core.module';
import { RefundsCoreModule } from '../refunds/refunds-core.module';
import { ApprovalsController } from './approvals.controller';
import { ApprovalsService } from './approvals.service';
import { SettingsApprovalsController } from './settings-approvals.controller';
import { SettingsApprovalsService } from './settings-approvals.service';

/**
 * F3-08 — gestes financiers à deux administrateurs. Chargé par le web
 * seulement (routes authentifiées) ; exporte le service pour les contrôleurs
 * qui ouvrent une demande (compte de versement, remboursement).
 */
@Module({
  imports: [
    AdminAuditModule,
    AuthModule,
    RefundsCoreModule,
    // R-09 — invalider le cache des réglages après une approbation appliquée.
    PlatformSettingsCoreModule,
  ],
  controllers: [ApprovalsController, SettingsApprovalsController],
  providers: [ApprovalsService, SettingsApprovalsService],
  exports: [ApprovalsService],
})
export class ApprovalsModule {}
