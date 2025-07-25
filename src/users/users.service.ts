/* eslint-disable prettier/prettier */
// src/user/user.service.ts
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service'; // Assurez-vous d'avoir un service Prisma correctement configuré
import { Prisma } from '@prisma/client';

@Injectable()
export class UserService {
  constructor(private prisma: PrismaService) {}

  async createUser(data: Prisma.UserCreateInput) {
    return this.prisma.user.create({
      data
    });
  }

  async findOrCreateUserFromFirebase(decodedToken: any) {
    const firebaseUid = decodedToken.uid;
    const email = decodedToken.email;
    const displayName = decodedToken.name || null; // 'name' est souvent le displayName

    // Cherche l'utilisateur par son UID Firebase
    let user = await this.prisma.user.findUnique({
      where: { firebaseUid: firebaseUid },
    });

    if (!user) {
      // Si l'utilisateur n'existe pas, créez-le
      user = await this.prisma.user.create({
        data: {
          firebaseUid: firebaseUid,
          email: email,
          nom: displayName,
          role: 'CLIENT',
        },
        
      });
      console.log(`Nouvel utilisateur créé dans la base de données : ${email}`);
    } else {
      // Optionnel : Mettez à jour les informations de l'utilisateur si elles ont changé dans Firebase
      // Par exemple, si l'e-mail ou le nom d'affichage est mis à jour dans Firebase
      if (user.email !== email || user.nom !== displayName) {
         user = await this.prisma.user.update({
            where: { id: user.id },
            data: {
               email: email,
               nom: displayName,
            },
         });
         console.log(`Informations utilisateur mises à jour : ${email}`);
      }
    }
    return user;
  }

  // Vous pouvez ajouter d'autres méthodes CRUD ici si nécessaire
  async getUserById(id: string) {
    return this.prisma.user.findUnique({ where: { id } });
  }

  async updateUser(id: string, data: Prisma.UserUpdateInput) {
    return this.prisma.user.update({
      where: { id },
      data,
    });
  }
}
