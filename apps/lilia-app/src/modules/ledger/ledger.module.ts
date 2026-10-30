import { Module } from '@nestjs/common';

import { AdminLedgerController } from './admin-ledger.controller';
import { AdminReconciliationController } from './admin-reconciliation.controller';
import { LedgerCoreModule } from './ledger-core.module';

/** Routes ADMIN du grand livre et du rapprochement — API seulement. */
@Module({
  imports: [LedgerCoreModule],
  controllers: [AdminLedgerController, AdminReconciliationController],
})
export class LedgerModule {}
