/* eslint-disable prettier/prettier */
// src/user/user.service.ts
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '@prisma/client';
import { UpdateUserDto } from './dto/update-user.dto';

@Injectable()
export class UserService {
  constructor(private prisma: PrismaService) {}

  async createUser(data: Prisma.UserCreateInput) {
    return this.prisma.user.create({
      data,
    });
  }

  async findUserByFirebaseUid(firebaseUid: string) {
    return this.prisma.user.findUnique({
      where: { firebaseUid },
    });
  }

  async findOrCreateUserFromFirebase(decodedToken: any) {
    const firebaseUid = decodedToken.uid;
    const email = decodedToken.email;
    const displayName = decodedToken.name || null;

    let user = await this.findUserByFirebaseUid(firebaseUid);

    if (!user) {
      console.warn(`Tentative de synchronisation pour un utilisateur inexistant: ${firebaseUid}`);
      return null;
    }

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

  async getUserById(id: string) {
    return this.prisma.user.findUnique({ where: { id } });
  }

  async updateUser(id: string, data: UpdateUserDto) {
    return this.prisma.user.update({
      where: { id },
      data,
    });
  }

  async findUserOrders(userId: string) {
    return this.prisma.order.findMany({
      where: {
        userId: userId,
      },
      include: {
        items: true, // Inclure les détails des articles de la commande
        restaurant: {
          select: {
            nom: true, // On peut aussi inclure le nom du restaurant
          }
        }
      },
      orderBy: {
        createdAt: 'desc', // Trier par date de création, la plus récente en premier
      },
    });
  }
}
