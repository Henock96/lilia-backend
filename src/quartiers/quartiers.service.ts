/* eslint-disable prettier/prettier */
import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { CreateDeliveryZoneDto, UpdateDeliveryZoneDto } from './dto/delivery-zone.dto';

// Liste des quartiers de Brazzaville
export const QUARTIERS_BRAZZAVILLE = [
  // Centre-ville
  'Centre-ville',
  'Plateau',
  'La Gare',
  'Marché Total',
  'Marché Poto-Poto',
  // Arrondissement 1 - Makélékélé
  'Makélékélé',
  //'Ngangouoni',
  //'Matour',
  'Bifouiti',
  //'Mbota',

  // Arrondissement 2 - Bacongo
  'Bacongo',
  //'Mpissa',
  //'Saint-Pierre',

  // Arrondissement 3 - Poto-Poto
  'Poto-Poto',
  'Moukondo',
  'Plateau des 15 ans',

  // Arrondissement 4 - Moungali
  'Moungali',
  'Ouenzé',
  //'Moukoundzi-Ngouaka',
  //'Dragage',

  // Arrondissement 5 - Ouenzé
  //'La Tsiémé',
  'Mpila',
  'Texaco',

  // Arrondissement 6 - Talangaï
  'Talangaï',
  'Mikalou',
  'Nkombo',
  'Massengo',
  //'Yoro',

  // Arrondissement 7 - Mfilou
  'Mfilou',
  'Ngamakosso',
  //'Madibou',
  'Kinsoundi',
  //'Mafouta',

  // Arrondissement 8 - Madibou
  //'Madibou-Gare',
  //'Mayanga',
  //'Mbouono',

  // Arrondissement 9 - Djiri
  'Djiri',
  //'Itatolo',
  //'Kibouendé',
  //'Sadelmi',

  
];

@Injectable()
export class QuartiersService {
  constructor(private prisma: PrismaService) {}

  /**
   * Récupère tous les quartiers de la base de données
   */
  async findAll() {
    return this.prisma.quartier.findMany({
      orderBy: { nom: 'asc' },
    });
  }

  /**
   * Initialise les quartiers de Brazzaville dans la base de données
   * À appeler une fois lors du setup ou via un endpoint admin
   */
  async seedQuartiers() {
    const existingCount = await this.prisma.quartier.count();

    if (existingCount > 0) {
      return {
        message: 'Les quartiers sont déjà initialisés',
        count: existingCount,
      };
    }

    const quartiers = await this.prisma.quartier.createMany({
      data: QUARTIERS_BRAZZAVILLE.map((nom) => ({
        nom,
        ville: 'Brazzaville',
      })),
      skipDuplicates: true,
    });

    return {
      message: 'Quartiers initialisés avec succès',
      count: quartiers.count,
    };
  }

  /**
   * Calcule les frais de livraison pour un restaurant et un quartier donnés
   */
  async calculateDeliveryFee(restaurantId: string, quartierId: string) {
    // Récupérer le restaurant avec sa configuration de livraison
    const restaurant = await this.prisma.restaurant.findUnique({
      where: { id: restaurantId },
      include: {
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

    // Si mode FIXED, retourner le prix fixe
    if (restaurant.deliveryPriceMode === 'FIXED') {
      return {
        mode: 'FIXED',
        fee: restaurant.fixedDeliveryFee,
        zoneName: null,
      };
    }

    // Si mode ZONE_BASED, chercher la zone correspondante au quartier
    const quartier = await this.prisma.quartier.findUnique({
      where: { id: quartierId },
    });

    if (!quartier) {
      throw new NotFoundException('Quartier non trouvé');
    }

    // Chercher la zone qui contient ce quartier
    for (const zone of restaurant.deliveryZones) {
      const hasQuartier = zone.quartiers.some(
        (qz) => qz.quartierId === quartierId,
      );
      if (hasQuartier) {
        return {
          mode: 'ZONE_BASED',
          fee: zone.fee,
          zoneName: zone.zoneName,
          quartierName: quartier.nom,
        };
      }
    }

    // Si le quartier n'est dans aucune zone, utiliser le prix fixe par défaut
    return {
      mode: 'ZONE_BASED',
      fee: restaurant.fixedDeliveryFee, // Prix par défaut
      zoneName: 'Zone par défaut',
      quartierName: quartier.nom,
      isDefaultZone: true,
    };
  }

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
