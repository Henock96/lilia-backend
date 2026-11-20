import { Module } from '@nestjs/common';
import { UserService } from './users.service';
import { UserDeletionService } from './user-deletion.service';
import { UsersController } from './users.controller';
import { AuthModule } from '../auth/auth.module';
import { FirebaseModule } from '../firebase/firebase.module';
import { ReferralCoreModule } from './referral-core.module';
import { TrackingModule } from '../tracking/tracking.module';

@Module({
  imports: [
    AuthModule, // pour UserCacheService (invalidation cache)
    FirebaseModule, // pour FirebaseService (suppression du compte Auth)
    // Parrainage + enregistrement des installations. Passe par le module
    // « core » (sans controller) : il est partagé avec `OrdersCoreModule`, donc
    // avec le graphe du worker.
    ReferralCoreModule,
    // SEC-08 — la suppression de compte révoque ses rooms de suivi.
    TrackingModule,
  ],
  providers: [UserService, UserDeletionService],
  controllers: [UsersController],
  exports: [UserService, ReferralCoreModule],
})
export class UsersModule {}
