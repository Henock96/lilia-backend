/* eslint-disable prettier/prettier */
// src/auth/auth.controller.ts (exemple d'un point d'accès protégé)
import { Controller, Get, UseGuards, Req, Put, Body, Post } from '@nestjs/common';
import { Request } from 'express'; // Pour le type de la requête
import { FirebaseAuthGuard } from '../firebase/firebase-auth.guard';
import { UserService } from '../users/users.service'; // Votre service utilisateur
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';

@Controller('auth')
export class AuthController {
  constructor(private readonly userService: UserService) {}

  @Post('register')
  async registerUser(@Body() createUserDto: CreateUserDto) {
    const { firebaseUid, email, nom, telephone } = createUserDto;
    const newUser = await this.userService.createUser({
      firebaseUid,
      email,
      nom,
      phone: telephone,
      role: 'CLIENT', // Rôle par défaut
    });
    return {
      message: 'Utilisateur enregistré avec succès !',
      user: newUser,
    };
  }

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

  @UseGuards(FirebaseAuthGuard)
  @Put('profile')
  async updateProfile(@Req() req: Request, @Body() updateUserDto: UpdateUserDto) {
    const firebaseUser = (req as any).user;
    const localUser = await this.userService.findOrCreateUserFromFirebase(firebaseUser);
    const updatedUser = await this.userService.updateUser(localUser.id, updateUserDto);
    return {
      message: 'Profil mis à jour avec succès !',
      user: updatedUser,
    };
  }
}

