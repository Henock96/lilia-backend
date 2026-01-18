/* eslint-disable prettier/prettier */
import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';

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
}
