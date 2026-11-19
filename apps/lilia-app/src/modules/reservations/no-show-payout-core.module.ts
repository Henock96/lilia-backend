import { Module } from '@nestjs/common';

import { PrismaModule } from '../../prisma/prisma.module';
import { PaymentCoreModule } from '../payments/payment-core.module';
import { NoShowPayoutProviderService } from './no-show-payout-provider.service';
import { NoShowPayoutService } from './no-show-payout.service';

/**
 * 4B-2 J6b — versement de la part restaurant d'une absence, **sans
 * controller** : importé par les approbations (exécution), le webhook pawaPay
 * et la réconciliation, dont celle du worker (`worker.module.spec.ts`).
 * `PaymentCoreModule` et jamais `PaymentModule`, pour la même raison.
 */
@Module({
  imports: [PrismaModule, PaymentCoreModule],
  providers: [NoShowPayoutService, NoShowPayoutProviderService],
  exports: [NoShowPayoutService, NoShowPayoutProviderService],
})
export class NoShowPayoutCoreModule {}
