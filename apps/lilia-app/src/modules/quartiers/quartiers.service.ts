/* eslint-disable prettier/prettier */
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { checkCongoCoordinates } from '../../common/geo/congo-geo';
import { PUBLIC_VENDOR_WHERE } from '../../common/vendor-visibility';
import { DeliveryPricingService } from '../delivery-pricing/delivery-pricing.service';

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
  'Mpissa',
  'Saint-Pierre',

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
  'La Tsiémé',
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
  constructor(
    private prisma: PrismaService,
    // F3-02 : même moteur que le checkout, pour que le prix affiché soit le
    // prix facturé.
    private readonly deliveryPricing: DeliveryPricingService,
  ) {}

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
   * Pose le centroïde d'un quartier — repli de position pour les adresses
   * clients qui n'en ont pas.
   *
   * Les coordonnées passent par le même contrôle que les vendeurs et les
   * adresses : hors du Congo, inversées ou `(0, 0)` sont refusées. Un
   * centroïde faux se propagerait à **toutes** les commandes du quartier.
   */
  async setCentroid(id: string, latitude: number, longitude: number) {
    const check = checkCongoCoordinates(latitude, longitude);
    if (!check.ok) throw new BadRequestException(check.message);

    const quartier = await this.prisma.quartier.findUnique({ where: { id } });
    if (!quartier) throw new NotFoundException('Quartier non trouvé');

    const updated = await this.prisma.quartier.update({
      where: { id },
      data: { latitude, longitude },
    });
    return { data: updated, message: `Centroïde de ${updated.nom} enregistré` };
  }

  /**
   * Devis de livraison servi par la route **publique**.
   *
   * Même frontière que la fiche, les zones et le catalogue d'un vendeur
   * (`PUBLIC_VENDOR_WHERE`, importée — jamais recopiée) : les frais d'un
   * vendeur en configuration ou suspendu n'ont pas à être lisibles sans
   * authentification. Le calcul lui-même reste `calculateDeliveryFee`, que le
   * checkout appelle directement derrière sa propre garde.
   */
  async quotePublicDeliveryFee(
    restaurantId: string,
    quartierId: string,
    subTotal?: number,
  ) {
    const vendor = await this.prisma.restaurant.findFirst({
      where: { id: restaurantId, ...PUBLIC_VENDOR_WHERE },
      // Ce qu'il faut au moteur, rien de plus : la réponse n'expose que des
      // montants calculés et le seuil de livraison offerte (R10).
      select: {
        id: true,
        latitude: true,
        longitude: true,
        quartierId: true,
        deliverySubsidyMode: true,
        deliverySubsidyXaf: true,
        freeDeliveryThresholdXaf: true,
      },
    });
    if (!vendor) throw new NotFoundException('Vendeur introuvable');

    // F3-02 — même moteur que le checkout. `null` = mode VENDOR_LEGACY.
    const quote = await this.deliveryPricing.quoteForVendor({
      vendor,
      destination: { quartierId, latitude: null, longitude: null },
      subTotalXaf: subTotal ?? 0,
    });
    if (!quote) return this.calculateDeliveryFee(restaurantId, quartierId);

    return {
      mode: 'PLATFORM' as const,
      // Prix client : la seule clé que lisent les apps déjà publiées.
      fee: quote.customerFeeXaf,
      baseFee: quote.baseFeeXaf,
      vendorSubsidy: quote.subsidyXaf,
      distanceKm: quote.distanceKm,
      tariffVersion: quote.tariffVersion,
      // Permet « Livraison offerte dès 10 000 FCFA (encore 2 300) ».
      freeDeliveryThreshold:
        vendor.deliverySubsidyMode === 'FREE_ABOVE'
          ? vendor.freeDeliveryThresholdXaf
          : null,
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
          // Ordre **déterministe**, en défense en profondeur.
          //
          // La boucle plus bas retourne la première zone contenant le quartier.
          // Sans `orderBy`, PostgreSQL ne garantit aucun ordre : si un
          // chevauchement existait, deux clients du même quartier pouvaient
          // payer deux tarifs différents — et rien ne l'aurait signalé.
          //
          // Le chevauchement est désormais impossible en base
          // (`@@unique([restaurantId, quartierId])`), donc au plus une zone
          // correspond et cet ordre ne change plus rien. Il est conservé parce
          // qu'une lecture ne doit pas dépendre d'une contrainte d'écriture
          // pour être correcte : si la contrainte disparaissait, ou sur une
          // base restaurée avant la migration, le tarif le plus bas gagne —
          // le même arbitrage que celui posé dans la migration.
          orderBy: [{ fee: 'asc' }, { id: 'asc' }],
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
}
