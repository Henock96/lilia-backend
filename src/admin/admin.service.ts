import { Injectable, InternalServerErrorException } from '@nestjs/common';
import * as admin from 'firebase-admin';
import { PrismaService } from '../prisma/prisma.service';
import { CreateRestaurantWithOwnerDto } from './dto/create-restaurant-with-owner.dto';

@Injectable()
export class AdminService {
  constructor(private prisma: PrismaService) {}

  async createRestaurantWithOwner(dto: CreateRestaurantWithOwnerDto) {
    let firebaseUid: string | null = null;

    try {
      // 1. Create Firebase user
      const firebaseUser = await admin.auth().createUser({
        email: dto.email,
        password: dto.password,
        displayName: dto.nom,
      });
      firebaseUid = firebaseUser.uid;

      // 2. Create DB user + restaurant in a transaction
      const result = await this.prisma.$transaction(async (tx) => {
        const user = await tx.user.create({
          data: {
            firebaseUid: firebaseUser.uid,
            email: dto.email,
            nom: dto.nom,
            phone: dto.phone,
            role: 'RESTAURATEUR',
          },
        });

        const restaurant = await tx.restaurant.create({
          data: {
            nom: dto.restaurantNom,
            adresse: dto.restaurantAdresse,
            phone: dto.restaurantPhone,
            imageUrl: dto.restaurantImageUrl,
            ownerId: user.id,
          },
        });

        return { user, restaurant };
      });

      return result;
    } catch (error) {
      // Rollback: delete Firebase user if it was created
      if (firebaseUid) {
        try {
          await admin.auth().deleteUser(firebaseUid);
        } catch (rollbackError) {
          console.error(
            'Failed to rollback Firebase user:',
            rollbackError.message,
          );
        }
      }

      throw new InternalServerErrorException(
        `Erreur lors de la création: ${error.message}`,
      );
    }
  }
}
