/* eslint-disable prettier/prettier */
// auth/auth.module.ts
import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { FirebaseAuthGuard } from './guards/firebase-auth.guard';
import { RolesGuard } from './guards/roles.guard';
import { FirebaseModule } from '../firebase/firebase.module';
import { UserCacheService } from './services/user-cache.service';

/**
 * En enregistrant les guards via APP_GUARD,
 * ils s'appliquent GLOBALEMENT à toute l'application.
 * Les routes publiques utilisent @Public() pour être exemptées.
 *
 * UserCacheService est exporté pour permettre aux modules qui modifient
 * l'entité User (users, admin) d'invalider le cache.
 */
@Module({
  imports: [FirebaseModule],
  providers: [
    UserCacheService,
    { provide: APP_GUARD, useClass: FirebaseAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
  exports: [UserCacheService],
})
export class AuthModule {}