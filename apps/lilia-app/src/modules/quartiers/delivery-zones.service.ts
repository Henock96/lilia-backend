/* eslint-disable prettier/prettier */
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PUBLIC_VENDOR_WHERE } from '../../common/vendor-visibility';
import { assertNotLastZoneOfZoneBasedVendor } from '../../common/delivery/zone-coverage';
import { CreateDeliveryZoneDto, UpdateDeliveryZoneDto } from './dto/delivery-zone.dto';

@Injectable()
export class DeliveryZonesService {
  constructor(private prisma: PrismaService) {}

  /**
   * Récupère les zones de livraison d'un restaurant
   */
  /**
   * Route PUBLIQUE (`GET /quartiers/restaurant-zones`). La grille tarifaire
   * d'un vendeur non publié n'a pas à être consultable : même frontière que sa
   * fiche.
   */
  async getRestaurantDeliveryZones(restaurantId: string) {
    const restaurant = await this.prisma.restaurant.findFirst({
      where: { id: restaurantId, ...PUBLIC_VENDOR_WHERE },
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
   * Vue **de gestion** des zones — `GET /vendors/:id/delivery-zones`.
   *
   * ### Pourquoi elle n'existait pas, et pourquoi il en fallait une
   *
   * Le seul moyen de lire les zones d'un vendeur donné était
   * `getRestaurantDeliveryZones` ci-dessus, qui applique `PUBLIC_VENDOR_WHERE`.
   * Elle répond donc **404 sur un vendeur en `DRAFT`, non approuvé ou
   * suspendu** — c'est-à-dire précisément celui qu'on est en train de
   * configurer. L'autre chemin, `getMyDeliveryZones`, exige de **posséder** le
   * restaurant : un compte ADMIN, qui n'en possède aucun, recevait un 403.
   *
   * Entre les deux, l'administrateur n'avait aucune porte. C'est la troisième
   * occurrence du même motif dans ce dépôt — `GET /products` servi au
   * back-office catalogue, `GET /vendor-photos` servi à l'éditeur de galerie —
   * et il se corrige de la même façon : **une route de gestion distincte, pas
   * un assouplissement de la route publique.** Assouplir la publique exposerait
   * la grille tarifaire de vendeurs non publiés à tout le monde.
   *
   * ### La couverture est calculée ici, pas dans l'interface
   *
   * « Quels quartiers ne sont couverts par aucune zone ? » est une **règle
   * métier** : c'est elle qui dit quels clients paieront le tarif de repli. La
   * laisser à l'interface, c'est en avoir une version par client — et le web,
   * le Flutter et le prochain divergeront. Le serveur répond, les fronts
   * affichent. Même principe que la checklist de `VendorReadinessService`.
   */
  async getManagedDeliveryZones(restaurantId: string, firebaseUid: string) {
    const restaurant = await this.verifyOwnership(restaurantId, firebaseUid);

    const [zones, allQuartiers] = await Promise.all([
      this.prisma.deliveryZone.findMany({
        where: { restaurantId },
        include: { quartiers: { include: { quartier: true } } },
        // Ordre stable : sans lui, la grille se réordonne d'un chargement à
        // l'autre et l'administrateur ne retrouve pas la ligne qu'il éditait.
        orderBy: [{ fee: 'asc' }, { zoneName: 'asc' }],
      }),
      this.prisma.quartier.findMany({
        select: { id: true, nom: true },
        orderBy: { nom: 'asc' },
      }),
    ]);

    const coveredIds = new Set(
      zones.flatMap((zone) => zone.quartiers.map((qz) => qz.quartierId)),
    );
    const uncovered = allQuartiers.filter((q) => !coveredIds.has(q.id));

    return {
      data: {
        restaurantId: restaurant.id,
        nom: restaurant.nom,
        deliveryPriceMode: restaurant.deliveryPriceMode,
        fixedDeliveryFee: restaurant.fixedDeliveryFee,
        minimumOrderAmount: restaurant.minimumOrderAmount,
        estimatedDeliveryTimeMin: restaurant.estimatedDeliveryTimeMin,
        estimatedDeliveryTimeMax: restaurant.estimatedDeliveryTimeMax,
        supportsDelivery: restaurant.supportsDelivery,
        supportsPickup: restaurant.supportsPickup,
        zones,
        /**
         * `uncovered` n'est pertinent qu'en `ZONE_BASED`, mais il est calculé
         * dans les deux modes : c'est ce qui permet à l'interface de montrer
         * la couverture **avant** de basculer, plutôt que de découvrir le trou
         * après. `fallbackFee` nomme explicitement ce que ces quartiers
         * paieront — la valeur était jusqu'ici implicite dans le code.
         */
        coverage: {
          totalQuartiers: allQuartiers.length,
          coveredQuartiers: coveredIds.size,
          uncovered,
          fallbackFee: restaurant.fixedDeliveryFee,
        },
      },
    };
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
   * Quartiers demandés qui n'existent pas — fix L-7.
   *
   * `addQuartiersToZone` faisait déjà ce contrôle, `createDeliveryZone` non :
   * on y retombait sur une violation de clé étrangère traduite en 400
   * générique, qui ne dit ni quel identifiant est fautif ni pourquoi.
   */
  private async assertQuartiersExist(quartierIds: string[]) {
    if (quartierIds.length === 0) return;

    const found = await this.prisma.quartier.findMany({
      where: { id: { in: quartierIds } },
      select: { id: true },
    });
    if (found.length === quartierIds.length) return;

    const known = new Set(found.map((q) => q.id));
    const missing = quartierIds.filter((id) => !known.has(id));
    throw new BadRequestException(
      `Quartier(s) inconnu(s) : ${missing.join(', ')}.`,
    );
  }

  /**
   * Quartiers déjà couverts par une **autre** zone du même vendeur — fix L-6.
   *
   * L'unicité `(restaurantId, quartierId)` est portée par la base : c'est elle
   * qui garantit vraiment la règle. Ce contrôle applicatif ne la remplace pas,
   * il la **traduit** — un P2002 brut ne dit pas quel quartier bloque, ni dans
   * quelle zone il se trouve déjà, et c'est précisément ce qu'il faut savoir
   * pour corriger.
   */
  private async assertNoZoneOverlap(
    restaurantId: string,
    quartierIds: string[],
    exceptZoneId?: string,
  ) {
    if (quartierIds.length === 0) return;

    const taken = await this.prisma.quartierZone.findMany({
      where: {
        restaurantId,
        quartierId: { in: quartierIds },
        ...(exceptZoneId && { deliveryZoneId: { not: exceptZoneId } }),
      },
      select: {
        quartier: { select: { nom: true } },
        deliveryZone: { select: { zoneName: true } },
      },
    });
    if (taken.length === 0) return;

    const details = taken
      .map((t) => `${t.quartier.nom} (déjà dans « ${t.deliveryZone.zoneName} »)`)
      .join(', ');
    throw new BadRequestException(
      `Un quartier ne peut appartenir qu'à une seule zone chez le même ` +
        `vendeur — sinon son tarif serait indéterminé. À retirer de leur zone ` +
        `actuelle d'abord : ${details}.`,
    );
  }

  /**
   * Crée une zone de livraison pour un restaurant
   */
  async createDeliveryZone(restaurantId: string, firebaseUid: string, dto: CreateDeliveryZoneDto) {
    await this.verifyOwnership(restaurantId, firebaseUid);

    const quartierIds = dto.quartierIds ?? [];
    await this.assertQuartiersExist(quartierIds);
    await this.assertNoZoneOverlap(restaurantId, quartierIds);

    const zone = await this.prisma.deliveryZone.create({
      data: {
        zoneName: dto.zoneName,
        fee: dto.fee,
        restaurantId: restaurantId,
        ...(quartierIds.length > 0 && {
          // `restaurantId` est rempli par Prisma depuis le parent : la relation
          // est composite `(deliveryZoneId, restaurantId)`, donc la valeur ne
          // peut pas diverger de celle de la zone.
          quartiers: {
            create: quartierIds.map(quartierId => ({
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

    if (dto.quartierIds !== undefined) {
      await this.assertQuartiersExist(dto.quartierIds);
      // `exceptZoneId` : les quartiers déjà dans CETTE zone ne sont pas un
      // chevauchement, ils sont simplement reconduits.
      await this.assertNoZoneOverlap(zone.restaurantId, dto.quartierIds, zoneId);
    }

    // Fix L-5 : les trois écritures vivaient hors transaction. Un échec entre
    // le `deleteMany` et le `createMany` laissait une zone **tarifée mais sans
    // aucun quartier** — donc inopérante, et silencieusement : rien ne
    // distingue à l'œil une zone vide d'une zone qu'on n'a pas encore remplie.
    const updated = await this.prisma.$transaction(async (tx) => {
      if (dto.quartierIds !== undefined) {
        // Remplacement complet : c'est la sémantique de `quartierIds` dans ce
        // DTO — la liste envoyée EST la couverture voulue.
        await tx.quartierZone.deleteMany({
          where: { deliveryZoneId: zoneId },
        });

        if (dto.quartierIds.length > 0) {
          await tx.quartierZone.createMany({
            data: dto.quartierIds.map((quartierId) => ({
              quartierId,
              deliveryZoneId: zoneId,
              restaurantId: zone.restaurantId,
            })),
          });
        }
      }

      return tx.deliveryZone.update({
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

    // Fix L-3, versant symétrique : interdire de vider la couverture d'un
    // vendeur qui facture à la zone. Sans cette garde, le mode reste
    // `ZONE_BASED` et le tarif de repli s'applique partout — le même état
    // silencieux que celui obtenu en basculant le mode sans zone.
    const remaining = await this.prisma.deliveryZone.count({
      where: { restaurantId: zone.restaurantId, id: { not: zoneId } },
    });
    assertNotLastZoneOfZoneBasedVendor(
      zone.restaurant.deliveryPriceMode,
      remaining,
      zone.restaurant.supportsDelivery,
    );

    // `QuartierZone.deliveryZoneId` est en `onDelete: Cascade` depuis
    // l'activation des clés étrangères (août 2026) : PostgreSQL supprime les
    // rattachements lui-même. Le `deleteMany` préalable était l'émulation
    // manuelle de l'époque `relationMode = "prisma"`, et il faisait de cette
    // suppression deux écritures non atomiques.
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

    await this.assertQuartiersExist(quartierIds);
    await this.assertNoZoneOverlap(zone.restaurantId, quartierIds, zoneId);

    // ⚠️ `skipDuplicates` a été RETIRÉ. Il visait les doublons dans la même
    // zone — un geste sans conséquence, qu'on peut ignorer. Mais depuis
    // l'unicité `(restaurantId, quartierId)`, il couvrirait aussi le quartier
    // déjà rattaché à une AUTRE zone du vendeur : l'appel répondrait
    // « Quartiers ajoutés avec succès » en n'ajoutant rien, et
    // l'administrateur croirait avoir changé un tarif qui n'a pas bougé.
    //
    // Le chevauchement est désormais refusé explicitement, en nommant le
    // quartier et la zone qui le détient. `skipDuplicates` ne sert donc plus
    // qu'à masquer un cas déjà traité au-dessus.
    await this.prisma.quartierZone.createMany({
      data: quartierIds.map(quartierId => ({
        quartierId,
        deliveryZoneId: zoneId,
        restaurantId: zone.restaurantId,
      })),
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
