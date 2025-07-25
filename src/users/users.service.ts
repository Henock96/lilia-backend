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

  async findUserByFirebaseUid(firebaseUid: string) {
    return this.prisma.user.findUnique({
      where: { firebaseUid },
    });
  }

  // Cette méthode est appelée par le guard pour synchroniser les infos
  // Elle ne doit PAS créer d'utilisateur, seulement mettre à jour un existant.
  async findOrCreateUserFromFirebase(decodedToken: any) {
    const firebaseUid = decodedToken.uid;
    const email = decodedToken.email;
    const displayName = decodedToken.name || null;

    let user = await this.findUserByFirebaseUid(firebaseUid);

    if (!user) {
      // Si l'utilisateur n'existe pas, c'est une anomalie car il aurait dû
      // être créé lors de l'inscription. On ne le crée pas ici.
      // On pourrait logger cette anomalie.
      console.warn(`Tentative de synchronisation pour un utilisateur inexistant: ${firebaseUid}`);
      // On retourne null pour que le frontend sache que le profil n'est pas complet.
      return null;
    }

    // Mettre à jour les infos si elles ont changé dans Firebase
    if (user.email !== email || (displayName && user.nom !== displayName)) {
      user = await this.prisma.user.update({
        where: { id: user.id },
        data: {
          email: email,
          nom: displayName,
        },
      });
      console.log(`Informations utilisateur mises à jour : ${email}`);
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
