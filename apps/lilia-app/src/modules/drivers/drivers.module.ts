import { Module } from '@nestjs/common';

import { PrismaModule } from '../../prisma/prisma.module';
import { PaginationService } from '../../common/pagination/pagination.service';
import { FirebaseModule } from '../firebase/firebase.module';
import { AdminAuditModule } from '../admin-audit/admin-audit.module';
import { AuthModule } from '../auth/auth.module';
import { VendorsCoreModule } from '../vendors/vendors-core.module';
import { DriversService } from './drivers.service';
import {
  AdminDriversController,
  DriversController,
} from './drivers.controller';

/**
 * Gestion des comptes livreurs.
 *
 * Importe `VendorsCoreModule` pour `VendorInvitationService` : créer un compte
 * dont l'administrateur ignore le secret est exactement le même problème pour
 * un livreur que pour un vendeur, et deux implémentations d'un repli
 * divergent toujours. `VendorsCoreModule` ne déclare aucun controller — il
 * peut donc être importé sans entraîner de route dans le graphe.
 */
@Module({
  imports: [
    PrismaModule,
    FirebaseModule,
    AdminAuditModule,
    // Fournit UserCacheService, à invalider dès qu'on écrit sur `User`.
    AuthModule,
    VendorsCoreModule,
  ],
  controllers: [AdminDriversController, DriversController],
  providers: [DriversService, PaginationService],
  exports: [DriversService],
})
export class DriversModule {}
