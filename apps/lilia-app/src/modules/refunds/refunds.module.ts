import { Module } from '@nestjs/common';
import { RefundsCoreModule } from './refunds-core.module';
import { RefundsController } from './refunds.controller';

/**
 * Remboursements des commandes annulées après paiement (fix H5).
 *
 * Ce module ajoute l'**exposition HTTP** (`/refunds`, file admin) au service
 * porté par `RefundsCoreModule`. Les consommateurs internes — dont
 * `OrderLifecycleService`, qui ouvre la ligne au moment de l'annulation —
 * doivent importer le module core, pas celui-ci : voir le commentaire de
 * `refunds-core.module.ts` pour ce que coûte l'inverse.
 */
@Module({
  imports: [RefundsCoreModule],
  controllers: [RefundsController],
  exports: [RefundsCoreModule],
})
export class RefundsModule {}
