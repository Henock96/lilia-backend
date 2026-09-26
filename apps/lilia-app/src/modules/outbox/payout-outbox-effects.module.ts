import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { NotificationsCoreModule } from '../notifications/notifications-core.module';
import { PayoutOutboxEffectsService } from './payout-outbox-effects.service';
import { ApprovalOutboxEffectsService } from './approval-outbox-effects.service';
import { VendorOfferOutboxEffectsService } from '../vendor-offers/vendor-offer-outbox-effects.service';

/**
 * Notifications de versement dépilées par l'outbox (F3-07).
 *
 * ⚠️ Chargé par le web ET par le worker, composé de modules « core » : aucun
 * controller ne se monte. `OutboxModule` (global) fournit le dispatcher.
 */
@Module({
  imports: [PrismaModule, NotificationsCoreModule],
  // F3-08 — les demandes d'approbation, même mécanique.
  // F3-11 — les avis d'offre boutique au vendeur, même mécanique.
  providers: [
    PayoutOutboxEffectsService,
    ApprovalOutboxEffectsService,
    VendorOfferOutboxEffectsService,
  ],
})
export class PayoutOutboxEffectsModule {}
