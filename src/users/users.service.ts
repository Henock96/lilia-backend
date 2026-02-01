/* eslint-disable prettier/prettier */
// src/user/user.service.ts
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '@prisma/client';
import { UpdateUserDto } from './dto/update-user.dto';
import { UserCreatedEvent } from 'src/events/user-events';
import { EventEmitter2 } from '@nestjs/event-emitter';


@Injectable()
export class UserService {
  constructor(private prisma: PrismaService,     private eventEmitter: EventEmitter2,
  ) {}

  async createUser(data: Prisma.UserCreateInput) {
    return this.prisma.user.create({
      data,
    });
  }

  async findUserByFirebaseUid(firebaseUid: string) {
    return this.prisma.user.findUnique({
      where: { firebaseUid },
      include: {
        restaurant: true, // Inclure le restaurant pour les admins/restaurateurs
      },
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
    // 🔥 ÉMETTRE L'ÉVÉNEMENT au lieu d'appeler directement les notifications
    const userCreatedEvent = new UserCreatedEvent(
      user.id,
      user.nom,
      user.createdAt
    );

    this.eventEmitter.emit('user.created', userCreatedEvent);
    return user;
  }

  // Nouvelle méthode pour gérer inscription ET connexion
  async syncUserFromFirebase(firebaseUid: string, email: string, nom?: string, phone?: string, imageUrl?: string) {
    // Vérifier d'abord si l'utilisateur existe
    const existingUser = await this.prisma.user.findUnique({
      where: { firebaseUid },
    });

    const isNewUser = !existingUser;

    // Upsert : créer si n'existe pas, mettre à jour si existe
    const user = await this.prisma.user.upsert({
      where: { firebaseUid },
      update: {
        email,
        nom: nom || undefined,
        phone: phone || undefined,
        imageUrl: imageUrl || undefined,
      },
      create: {
        firebaseUid,
        email,
        nom: nom || email.split('@')[0], // Utiliser la partie avant @ si pas de nom
        phone: phone || '',
        imageUrl: imageUrl || null,
        role: 'CLIENT', // Rôle par défaut
      },
    });

    console.log(`✅ User synchronized: ${user.email} (${user.id})`);

    // Émettre l'événement uniquement pour les nouveaux utilisateurs
    if (isNewUser) {
      console.log(`🎉 New user registered, emitting user.created event`);
      const userCreatedEvent = new UserCreatedEvent(
        user.id,
        user.nom,
        user.createdAt
      );
      this.eventEmitter.emit('user.created', userCreatedEvent);
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
