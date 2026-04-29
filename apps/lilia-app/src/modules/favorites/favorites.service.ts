import { Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class FavoritesService {
  constructor(private readonly prisma: PrismaService) {}

  async getMyFavorites(userId: string) {
    const favorites = await this.prisma.favorite.findMany({
      where: { userId },
      include: {
        restaurant: {
          include: { specialties: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    return favorites.map((f) => this.formatRestaurant(f.restaurant));
  }

  async addFavorite(userId: string, restaurantId: string) {
    const restaurant = await this.prisma.restaurant.findUnique({ where: { id: restaurantId } });
    if (!restaurant) throw new NotFoundException('Restaurant introuvable');

    try {
      await this.prisma.favorite.create({ data: { userId, restaurantId } });
    } catch (e: any) {
      if (e?.code === 'P2002') throw new ConflictException('Deja en favoris');
      throw e;
    }

    return { message: 'Ajoute aux favoris' };
  }

  async removeFavorite(userId: string, restaurantId: string) {
    await this.prisma.favorite.deleteMany({ where: { userId, restaurantId } });
  }

  async isFavorite(userId: string, restaurantId: string) {
    const fav = await this.prisma.favorite.findUnique({
      where: { userId_restaurantId: { userId, restaurantId } },
    });
    return { isFavorite: !!fav };
  }

  private formatRestaurant(r: any) {
    return {
      id: r.id,
      nom: r.nom,
      adresse: r.adresse,
      imageUrl: r.imageUrl,
      isOpen: r.isOpen ?? true,
      estimatedDeliveryTimeMin: r.estimatedDeliveryTimeMin ?? 15,
      estimatedDeliveryTimeMax: r.estimatedDeliveryTimeMax ?? 30,
      fixedDeliveryFee: r.fixedDeliveryFee ?? 500,
      minimumOrderAmount: r.minimumOrderAmount ?? 0,
      specialties: r.specialties ?? [],
    };
  }
}
