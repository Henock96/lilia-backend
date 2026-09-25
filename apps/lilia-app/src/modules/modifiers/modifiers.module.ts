import { Module } from '@nestjs/common';

import { PrismaModule } from '../../prisma/prisma.module';
import { AdminAuditModule } from '../admin-audit/admin-audit.module';
import { PlatformSettingsCoreModule } from '../platform-settings/platform-settings-core.module';
import { RestaurantsModule } from '../restaurants/restaurants.module';
import { ModifiersController } from './modifiers.controller';
import { ModifiersService } from './modifiers.service';

/**
 * F3-09 — éditeur d'options. Le moteur de sélection, lui, n'est pas un
 * provider : ce sont des fonctions pures (`modifier-selection.ts`), importées
 * par le panier, le checkout, le recommander et le catalogue.
 */
@Module({
  imports: [
    PrismaModule,
    RestaurantsModule, // RestaurantAccessService
    AdminAuditModule,
    PlatformSettingsCoreModule,
  ],
  controllers: [ModifiersController],
  providers: [ModifiersService],
})
export class ModifiersModule {}
