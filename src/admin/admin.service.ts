import {
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
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
          console.error('Failed to rollback Firebase user:', rollbackError);
        }
      }

      throw new InternalServerErrorException(
        `Erreur lors de la création: ${error}`,
      );
    }
  }

  async toggleRestaurantActive(restaurantId: string, isActive: boolean) {
    const restaurant = await this.prisma.restaurant.findUnique({
      where: { id: restaurantId },
    });

    if (!restaurant) {
      throw new NotFoundException('Restaurant non trouvé');
    }

    const updated = await this.prisma.restaurant.update({
      where: { id: restaurantId },
      data: { isActive },
      include: { specialties: true, operatingHours: true },
    });

    return {
      data: updated,
      message: isActive ? 'Restaurant activé' : 'Restaurant désactivé',
    };
  }

  /**
   * Récupère tous les clients de la plateforme (ADMIN uniquement)
   */
  async getAllClients() {
    const clients = await this.prisma.user.findMany({
      where: { role: 'CLIENT' },
      select: {
        id: true,
        firebaseUid: true,
        nom: true,
        email: true,
        phone: true,
        imageUrl: true,
        createdAt: true,
        _count: { select: { adresses: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    // Ajouter le count des commandes pour chaque client
    const clientsWithOrders = await Promise.all(
      clients.map(async (client) => {
        const orderStats = await this.prisma.order.aggregate({
          where: { userId: client.id },
          _count: { id: true },
          _sum: { total: true },
        });
        return {
          ...client,
          orderCount: orderStats._count.id,
          totalSpent: orderStats._sum.total || 0,
        };
      }),
    );

    return {
      data: clientsWithOrders,
      message: 'Liste des clients récupérée',
    };
  }

  async getAllRestaurants() {
    const restaurants = await this.prisma.restaurant.findMany({
      include: {
        owner: { select: { id: true, nom: true, email: true, phone: true } },
        specialties: true,
        _count: { select: { orders: true, products: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    return {
      data: restaurants,
      message: 'Liste des restaurants récupérée',
    };
  }
}
