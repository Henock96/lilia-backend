import { Module } from '@nestjs/common';

import { PrismaModule } from '../../prisma/prisma.module';
import { AdminAuditModule } from '../admin-audit/admin-audit.module';
import { PlatformSettingsCoreModule } from '../platform-settings/platform-settings-core.module';
import { VendorOffersService } from './vendor-offers.service';

/**
 * Service des offres boutique (F3-11), sans controller.
 *
 * ⚠️ Chargé par le web ET par le worker (annulations, expiration de paiement,
 * échéance des offres) : dépendances explicites, aucune ne suppose un module
 * global que seul `AppModule` monte. `OutboxModule`, lui, est global des deux
 * côtés.
 */
@Module({
  imports: [PrismaModule, PlatformSettingsCoreModule, AdminAuditModule],
  providers: [VendorOffersService],
  exports: [VendorOffersService],
})
export class VendorOffersCoreModule {}
