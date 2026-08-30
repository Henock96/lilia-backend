import { Module } from '@nestjs/common';
import { UserService } from './users.service';
import { UserDeletionService } from './user-deletion.service';
import { ReferralService } from './referral.service';
import { UsersController } from './users.controller';
import { AuthModule } from '../auth/auth.module';
import { FirebaseModule } from '../firebase/firebase.module';
import { PlatformSettingsModule } from '../platform-settings/platform-settings.module';

@Module({
  imports: [
    AuthModule, // pour UserCacheService (invalidation cache)
    FirebaseModule, // pour FirebaseService (suppression du compte Auth)
    PlatformSettingsModule, // pour ReferralService (barème des bonus)
  ],
  providers: [UserService, UserDeletionService, ReferralService],
  controllers: [UsersController],
  // ReferralService est consommé par PaymentListener (provider global) depuis
  // que la récompense de parrainage est branchée sur le paiement (fix C3).
  exports: [UserService, ReferralService],
})
export class UsersModule {}
