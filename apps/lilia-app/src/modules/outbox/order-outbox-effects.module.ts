import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { NotificationsCoreModule } from '../notifications/notifications-core.module';
import { LoyaltyModule } from '../loyalty/loyalty.module';
import { ReferralCoreModule } from '../users/referral-core.module';
import { RefundsCoreModule } from '../refunds/refunds-core.module';
import { OrderOutboxEffectsService } from './order-outbox-effects.service';

/**
 * Traitements outbox des effets de commande (lot 4).
 *
 * ⚠️ Chargé par le web ET par le worker (c'est le worker qui dépile), et
 * composé exclusivement de modules « core » : aucun controller ne se monte.
 * `OutboxModule` (global) fournit `OutboxService` et le dispatcher.
 */
@Module({
  imports: [
    PrismaModule,
    NotificationsCoreModule,
    LoyaltyModule,
    ReferralCoreModule,
    RefundsCoreModule,
  ],
  providers: [OrderOutboxEffectsService],
})
export class OrderOutboxEffectsModule {}
