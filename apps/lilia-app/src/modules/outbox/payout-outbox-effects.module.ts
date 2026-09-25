import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { NotificationsCoreModule } from '../notifications/notifications-core.module';
import { PayoutOutboxEffectsService } from './payout-outbox-effects.service';

/**
 * Notifications de versement dépilées par l'outbox (F3-07).
 *
 * ⚠️ Chargé par le web ET par le worker, composé de modules « core » : aucun
 * controller ne se monte. `OutboxModule` (global) fournit le dispatcher.
 */
@Module({
  imports: [PrismaModule, NotificationsCoreModule],
  providers: [PayoutOutboxEffectsService],
})
export class PayoutOutboxEffectsModule {}
