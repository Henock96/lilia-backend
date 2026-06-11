/* eslint-disable prettier/prettier */
import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateDeliveryZoneDto, UpdateDeliveryZoneDto } from './dto/delivery-zone.dto';

@Injectable()
export class DeliveryZonesService {
  constructor(private prisma: PrismaService) {}

  /**
   * Récupère les zones de livraison d'un restaurant
   */
  async getRestaurantDeliveryZones(restaurantId: string) {
    const restaurant = await this.prisma.restaurant.findUnique({
      where: { id: restaurantId },
      select: {
        id: true,
        nom: true,
        deliveryPriceMode: true,
        fixedDeliveryFee: true,
        deliveryZones: {
          include: {
            quartiers: {
              include: {
                quartier: true,
              },
            },
          },
        },
      },
    });

    if (!restaurant) {
      throw new NotFoundException('Restaurant non trouvé');
    }

    return restaurant;
  }

  /**
   * Vérifie que l'utilisateur est bien le propriétaire du restaurant
   */
  private async verifyOwnership(restaurantId: string, firebaseUid: string) {
    const user = await this.prisma.user.findUnique({
      where: { firebaseUid },
    });

    if (!user) {
      throw new NotFoundException('Utilisateur non trouvé');
    }

    const restaurant = await this.prisma.restaurant.findUnique({
      where: { id: restaurantId },
    });

    if (!restaurant) {
      throw new NotFoundException('Restaurant non trouvé');
    }

    if (restaurant.ownerId !== user.id && user.role !== 'ADMIN') {
      throw new ForbiddenException('Vous n\'êtes pas autorisé à modifier ce restaurant');
    }

    return restaurant;
  }

  /**
   * Crée une zone de livraison pour un restaurant
   */
  async createDeliveryZone(restaurantId: string, firebaseUid: string, dto: CreateDeliveryZoneDto) {
    await this.verifyOwnership(restaurantId, firebaseUid);

    const zone = await this.prisma.deliveryZone.create({
      data: {
        zoneName: dto.zoneName,
        fee: dto.fee,
        restaurantId: restaurantId,
        ...(dto.quartierIds && dto.quartierIds.length > 0 && {
          quartiers: {
            create: dto.quartierIds.map(quartierId => ({
              quartierId,
            })),
          },
        }),
      },
      include: {
        quartiers: {
          include: {
            quartier: true,
          },
        },
      },
    });

    return {
      data: zone,
      message: 'Zone de livraison créée avec succès',
    };
  }

  /**
   * Met à jour une zone de livraison
   */
  async updateDeliveryZone(zoneId: string, firebaseUid: string, dto: UpdateDeliveryZoneDto) {
    const zone = await this.prisma.deliveryZone.findUnique({
      where: { id: zoneId },
      include: { restaurant: true },
    });

    if (!zone) {
      throw new NotFoundException('Zone de livraison non trouvée');
    }

    await this.verifyOwnership(zone.restaurantId, firebaseUid);

    // Si on met à jour les quartiers, on supprime les anciens et on crée les nouveaux
    if (dto.quartierIds !== undefined) {
      await this.prisma.quartierZone.deleteMany({
        where: { deliveryZoneId: zoneId },
      });

      if (dto.quartierIds.length > 0) {
        await this.prisma.quartierZone.createMany({
          data: dto.quartierIds.map(quartierId => ({
            quartierId,
            deliveryZoneId: zoneId,
          })),
        });
      }
    }

    const updated = await this.prisma.deliveryZone.update({
      where: { id: zoneId },
      data: {
        ...(dto.zoneName && { zoneName: dto.zoneName }),
        ...(dto.fee !== undefined && { fee: dto.fee }),
      },
      include: {
        quartiers: {
          include: {
            quartier: true,
          },
        },
      },
    });

    return {
      data: updated,
      message: 'Zone de livraison mise à jour avec succès',
    };
  }

  /**
   * Supprime une zone de livraison
   */
  async deleteDeliveryZone(zoneId: string, firebaseUid: string) {
    const zone = await this.prisma.deliveryZone.findUnique({
      where: { id: zoneId },
      include: { restaurant: true },
    });

    if (!zone) {
      throw new NotFoundException('Zone de livraison non trouvée');
    }

    await this.verifyOwnership(zone.restaurantId, firebaseUid);

    // Supprimer d'abord les relations quartier-zone
    await this.prisma.quartierZone.deleteMany({
      where: { deliveryZoneId: zoneId },
    });

    // Supprimer la zone
    await this.prisma.deliveryZone.delete({
      where: { id: zoneId },
    });

    return {
      message: 'Zone de livraison supprimée avec succès',
    };
  }

  /**
   * Ajoute des quartiers à une zone existante
   */
  async addQuartiersToZone(zoneId: string, firebaseUid: string, quartierIds: string[]) {
    const zone = await this.prisma.deliveryZone.findUnique({
      where: { id: zoneId },
      include: { restaurant: true },
    });

    if (!zone) {
      throw new NotFoundException('Zone de livraison non trouvée');
    }

    await this.verifyOwnership(zone.restaurantId, firebaseUid);

    // Vérifier que les quartiers existent
    const quartiers = await this.prisma.quartier.findMany({
      where: { id: { in: quartierIds } },
    });

    if (quartiers.length !== quartierIds.length) {
      throw new NotFoundException('Un ou plusieurs quartiers n\'existent pas');
    }

    // Ajouter les quartiers (en ignorant les doublons)
    await this.prisma.quartierZone.createMany({
      data: quartierIds.map(quartierId => ({
        quartierId,
        deliveryZoneId: zoneId,
      })),
      skipDuplicates: true,
    });

    const updated = await this.prisma.deliveryZone.findUnique({
      where: { id: zoneId },
      include: {
        quartiers: {
          include: {
            quartier: true,
          },
        },
      },
    });

    return {
      data: updated,
      message: 'Quartiers ajoutés avec succès',
    };
  }

  /**
   * Retire des quartiers d'une zone
   */
  async removeQuartiersFromZone(zoneId: string, firebaseUid: string, quartierIds: string[]) {
    const zone = await this.prisma.deliveryZone.findUnique({
      where: { id: zoneId },
      include: { restaurant: true },
    });

    if (!zone) {
      throw new NotFoundException('Zone de livraison non trouvée');
    }

    await this.verifyOwnership(zone.restaurantId, firebaseUid);

    await this.prisma.quartierZone.deleteMany({
      where: {
        deliveryZoneId: zoneId,
        quartierId: { in: quartierIds },
      },
    });

    const updated = await this.prisma.deliveryZone.findUnique({
      where: { id: zoneId },
      include: {
        quartiers: {
          include: {
            quartier: true,
          },
        },
      },
    });

    return {
      data: updated,
      message: 'Quartiers retirés avec succès',
    };
  }

  /**
   * Récupère les zones de livraison pour le restaurant de l'utilisateur connecté
   */
  async getMyDeliveryZones(firebaseUid: string) {
    const restaurant = await this.prisma.restaurant.findFirst({
      where: { owner: { firebaseUid } },
      include: {
        deliveryZones: {
          include: {
            quartiers: {
              include: {
                quartier: true,
              },
            },
          },
          orderBy: { zoneName: 'asc' },
        },
      },
    });

    if (!restaurant) {
      throw new ForbiddenException('Vous devez posséder un restaurant');
    }

    return {
      data: restaurant.deliveryZones,
      restaurantId: restaurant.id,
      deliveryPriceMode: restaurant.deliveryPriceMode,
      fixedDeliveryFee: restaurant.fixedDeliveryFee,
    };
  }
}
