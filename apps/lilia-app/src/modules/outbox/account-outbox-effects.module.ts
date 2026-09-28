import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { FirebaseModule } from '../firebase/firebase.module';
import { UserCacheService } from '../auth/services/user-cache.service';
import { AccountOutboxEffectsService } from './account-outbox-effects.service';

/**
 * Effets de compte dépilés par l'outbox (F3-12.1 R7 : ban différé).
 *
 * ⚠️ Chargé par le web ET par le worker, composé de modules « core » : aucun
 * controller ne se monte. `UserCacheService` est fourni ici plutôt que tiré
 * d'`AuthModule`, qui porte les gardes globaux du web.
 */
@Module({
  imports: [PrismaModule, FirebaseModule],
  providers: [AccountOutboxEffectsService, UserCacheService],
})
export class AccountOutboxEffectsModule {}
