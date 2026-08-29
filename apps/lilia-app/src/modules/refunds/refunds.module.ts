import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { RefundsService } from './refunds.service';
import { RefundsController } from './refunds.controller';

/**
 * Remboursements des commandes annulées après paiement (fix H5).
 * `RefundsService` est exporté : `OrderLifecycleService` ouvre la ligne au
 * moment de l'annulation.
 */
@Module({
  imports: [PrismaModule],
  providers: [RefundsService],
  controllers: [RefundsController],
  exports: [RefundsService],
})
export class RefundsModule {}
