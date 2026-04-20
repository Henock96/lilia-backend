/* eslint-disable prettier/prettier */
// src/user/user.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { Prisma, User } from '@prisma/client';
import { UpdateUserDto } from './dto/update-user.dto';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../../prisma/prisma.service';
import { DecodedIdToken } from 'firebase-admin/auth';
import { UserCreatedEvent } from '../events/user-events';


@Injectable()
export class UserService {
  private readonly logger = new Logger(UserService.name);

  constructor(
    private prisma: PrismaService,
    private eventEmitter: EventEmitter2,
  ) {}

  /**
   * Crée un user manuellement (usage interne ou seed).
   * Pour la sync Firebase, préférer syncUserFromFirebase().
   */
  async createUser(data: Prisma.UserCreateInput) {
    return this.prisma.user.create({
      data,
    });
  }
   /**
   * Récupère un user par son UID Firebase.
   * Inclut le restaurant pour les RESTAURATEUR (utile dans les guards/controllers).
   */
  async findByFirebaseUid(firebaseUid: string) {
    return this.prisma.user.findUnique({
      where: { firebaseUid },
      include: {
        restaurant: true, // Inclure le restaurant pour les admins/restaurateurs
      },
    });
  }

  /**
   * Synchronise un utilisateur Firebase avec la base de données.
   *
   * Logique :
   * - Si le user n'existe pas → création + émission de user.created
   * - Si le user existe → mise à jour des champs modifiables (email, nom, imageUrl)
   *
   * Appelé par l'AuthController à chaque connexion/inscription depuis l'app mobile.
   * Le token Firebase décodé est le seul paramètre — pas de any.
   */
  async syncFromFirebase(decoded: DecodedIdToken, phone?: string) {
    const { uid, email, name, picture } = decoded;

    // Vérifier d'abord si l'utilisateur existe
    const existingUser = await this.prisma.user.findUnique({
      where: { firebaseUid: uid },
    });

    const isNewUser = !existingUser;

    // Upsert : créer si n'existe pas, mettre à jour si existe
    const user = await this.prisma.user.upsert({
      where: { firebaseUid: uid },
      create: {
        firebaseUid: uid,
        email: email ?? '',
        nom: name ?? email?.split('@')[0] ?? 'Utilisateur',// Utiliser la partie avant @ si pas de nom
        phone: phone ?? '',
        imageUrl: picture ?? null,
        role: 'CLIENT', // Rôle par défaut
      },
      update: {
        ...(email && { email }),
        ...(name && { nom: name }),
        ...(picture && { imageUrl: picture }),
        ...(phone && { phone }),
        lastLogin: new Date(),
      }
    });

    console.log(`✅ User synchronized: ${user.email} (${user.id})`);

    // Émettre l'événement uniquement pour les nouveaux utilisateurs
    if (isNewUser) {
      this.logger.log(`Nouvel utilisateur créé : ${user.email} (${user.id})`);
      const userCreatedEvent = new UserCreatedEvent(
        user.id,
        user.nom,
        user.createdAt
      );
      this.eventEmitter.emit('user.created', userCreatedEvent);
    }else{
      this.logger.log(`Utilisateur existant mis à jour : ${user.email}`);
    }

    return { user, isNewUser };
  }

  async findById(id: string) : Promise<User | null> {
    return this.prisma.user.findUnique({ where: { id } });
  }

  async updateUser(id: string, data: UpdateUserDto): Promise<User> {
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
