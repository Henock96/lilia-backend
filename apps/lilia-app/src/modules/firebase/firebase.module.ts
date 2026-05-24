/* eslint-disable prettier/prettier */
// src/firebase/firebase.module.ts (exemple d'un module dédié)
import { Module } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { FirebaseService } from './firebase.service';
import { FirebaseAuthGuard } from '../auth/guards/firebase-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { UserCacheService } from '../auth/services/user-cache.service';

@Module({
  providers: [
    FirebaseAuthGuard,
    RolesGuard,
    Reflector,
    FirebaseService,
    UserCacheService
  ],
  exports: [FirebaseAuthGuard, RolesGuard, FirebaseService],
})
export class FirebaseModule {
}
