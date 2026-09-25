import { Module } from '@nestjs/common';

import { AdminAuditModule } from '../admin-audit/admin-audit.module';
import { AuthModule } from '../auth/auth.module';
import { RefundsCoreModule } from '../refunds/refunds-core.module';
import { ApprovalsController } from './approvals.controller';
import { ApprovalsService } from './approvals.service';

/**
 * F3-08 — gestes financiers à deux administrateurs. Chargé par le web
 * seulement (routes authentifiées) ; exporte le service pour les contrôleurs
 * qui ouvrent une demande (compte de versement, remboursement).
 */
@Module({
  imports: [AdminAuditModule, AuthModule, RefundsCoreModule],
  controllers: [ApprovalsController],
  providers: [ApprovalsService],
  exports: [ApprovalsService],
})
export class ApprovalsModule {}
