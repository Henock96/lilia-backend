import { Module } from '@nestjs/common';

import { LedgerPosterService } from './ledger-poster.service';
import { LedgerService } from './ledger.service';
import { ReconciliationService } from './reconciliation.service';

/**
 * Services du grand livre et du rapprochement, SANS contrôleur (lot 2) :
 * importable par le worker, qui ne monte aucun guard (motif de
 * `PaymentCoreModule`).
 */
@Module({
  providers: [LedgerService, LedgerPosterService, ReconciliationService],
  exports: [LedgerService, LedgerPosterService, ReconciliationService],
})
export class LedgerCoreModule {}
