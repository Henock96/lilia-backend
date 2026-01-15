/* eslint-disable prettier/prettier */
import { Controller, Get, Param, UseGuards, Req, Post, Body, Put } from '@nestjs/common';
import { FirebaseAuthGuard } from 'src/firebase/firebase-auth.guard';
import { Roles } from 'src/firebase/roles.decorator';
import { RolesGuard } from 'src/firebase/roles.guard';
import { UserService } from './users.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';

@Controller('auth')
export class AuthController {
  constructor(private readonly userService: UserService) {}
     // Endpoint pour récupérer toutes les commandes d'un utilisateur spécifique

    @Get(':id/orders')
    @UseGuards(FirebaseAuthGuard, RolesGuard)
    @Roles('ADMIN', 'RESTAURATEUR')
    findUserOrders(@Param('id') id: string) {
        return this.userService.findUserOrders(id);
    }
    
    @Post('register')
    async registerUser(@Body() createUserDto: CreateUserDto) {
        const { firebaseUid, email, nom, telephone, imageUrl } = createUserDto;

        // Utiliser syncUserFromFirebase qui gère inscription ET connexion
        const user = await this.userService.syncUserFromFirebase(
            firebaseUid,
            email,
            nom,
            telephone,
            imageUrl
        );

        return {
            message: 'Utilisateur synchronisé avec succès !',
            user: user,
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