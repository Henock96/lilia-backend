/* eslint-disable prettier/prettier */
// src/auth/auth.controller.ts (exemple d'un point d'accès protégé)
import { Controller, Get, UseGuards, Req } from '@nestjs/common';
import { Request } from 'express'; // Pour le type de la requête
import { FirebaseAuthGuard } from '../firebase/firebase-auth.guard';
import { UserService } from '../users/users.service'; // Votre service utilisateur

@Controller('auth')
export class AuthController {
  constructor(private readonly userService: UserService) {}

  @UseGuards(FirebaseAuthGuard) // Appliquez le Guard ici
  @Get('profile')
  async getOrCreateUser(@Req() req: Request) {
    const firebaseUser = (req as any).user; // Informations décodées du jeton Firebase

    // Synchronisez ou récupérez l'utilisateur de votre BDD PostgreSQL
    const localUser = await this.userService.findOrCreateUserFromFirebase(firebaseUser);

    // Retournez les informations de l'utilisateur (celles de votre BDD ou celles de Firebase)
    return {
      message: 'Authentification réussie et profil récupéré !',
      firebaseInfo: firebaseUser,
      localDbInfo: localUser,
    };
  }
}

