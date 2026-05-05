/* eslint-disable prettier/prettier */
import { Controller, Get, Post, Body, Put, HttpCode, HttpStatus } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { UserService } from './users.service';
import { UpdateUserDto } from './dto/update-user.dto';
import { FirebaseUser } from '../auth/decorators/firebase-user.decorator';
import { DecodedIdToken } from 'firebase-admin/auth';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { User } from '@prisma/client';

/**
 * Gère le profil utilisateur.
 *
 * Les guards FirebaseAuthGuard + RolesGuard sont globaux (APP_GUARD dans AuthModule).
 * Pas besoin de @UseGuards() ici sauf exception.
 *
 * Routes :
 *   POST /users/sync     → sync Firebase → DB à chaque connexion/inscription
 *   GET  /users/me       → profil du user connecté
 *   PUT  /users/me       → mise à jour profil
 */
@Controller('users')
export class UsersController {
  constructor(private readonly userService: UserService) {}
     // Endpoint pour récupérer toutes les commandes d'un utilisateur spécifique

    /**
   * Synchronise le compte Firebase avec la base de données.
   *
   * Appelé par l'app mobile juste après la connexion Firebase réussie.
   * Le token Bearer est obligatoire — c'est lui qui prouve l'identité,
   * pas le body. On ne fait jamais confiance à un firebaseUid venant du body.
   *
   * Flux mobile :
   *   1. signInWithEmailAndPassword() ou signInWithGoogle() côté Firebase
   *   2. getIdToken() → envoi en Bearer header
   *   3. POST /users/sync (body optionnel : téléphone)
   *   4. Backend vérifie le token, upsert en DB, retourne le profil
   */
  @Post('sync')
  @Throttle({ short: { limit: 5, ttl: 1000 }, long: { limit: 15, ttl: 3600000 } })
  @HttpCode(HttpStatus.OK)
  async sync(
    @FirebaseUser() fbUser: DecodedIdToken,
    @Body('telephone') phone?: string,
    @Body('referralCode') referralCode?: string,
  ) {
    const { user, isNewUser } = await this.userService.syncFromFirebase(fbUser, phone, referralCode);
    return {
      message: isNewUser ? 'Compte créé avec succès.' : 'Profil synchronisé.',
      isNew: isNewUser,
      user,
    };
  }

  @Get('me/referral-stats')
  getReferralStats(@CurrentUser() user: User) {
    return this.userService.getReferralStats(user.id);
  }

  @Get('me/loyalty')
  getLoyaltyTransactions(@CurrentUser() user: User) {
    return this.userService.getLoyaltyTransactions(user.id);
  }


  /**
   * Retourne le profil complet du user connecté.
   * request.user est peuplé par RolesGuard — zéro requête DB supplémentaire.
   */
  @Get('me')
  getProfile(@CurrentUser() user: User) {
    return { user };
  }
  /**
   * Met à jour le profil du user connecté.
   * On utilise user.id depuis request.user — pas besoin de re-fetch.
   */
  @Put('me')
  async updateProfile(
    @CurrentUser() user: User,
    @Body() dto: UpdateUserDto,
  ) {
    const updated = await this.userService.updateUser(user.id, dto);
    return {
      message: 'Profil mis à jour avec succès.',
      user: updated,
    };
  }
}