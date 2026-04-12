/* eslint-disable prettier/prettier */
import { 
    BadRequestException, 
    ForbiddenException, 
    Injectable, 
    NotFoundException,
    Logger,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
    CreateRestaurantDto,
    UpdateDeliverySettingsDto,
    UpdateOpenStatusDto,
    AddSpecialtyDto,
    UpdateRestaurantDto
} from './dto/create-restaurant.dto';
import { DayOfWeek, SetOperatingHoursDto, UpdateOperatingHourDto } from './dto/operating-hours.dto';

/** Include standard pour les réponses restaurant */
const RESTAURANT_INCLUDE = {
  specialties: true,
  operatingHours: true,
} as const;

/** Include avec reviews pour le calcul de note */
const RESTAURANT_WITH_REVIEWS = {
  ...RESTAURANT_INCLUDE,
  reviews: { select: { rating: true } },
} as const;

@Injectable()
export class RestaurantsService {
    private readonly logger = new Logger(RestaurantsService.name);

    constructor(private prisma: PrismaService){}

    // ─── CRÉATION ──────────────────────────────────────────────────────────────

    async create(data: CreateRestaurantDto, firebaseUid: string){
        // 1. Trouver l'utilisateur par son firebaseUid
        const user = await this.prisma.user.findUnique({
            where: { firebaseUid },
        });

        if (!user) {
            throw new NotFoundException("Utilisateur non trouvé.");
        }

        // 2. Vérifier si cet utilisateur a déjà un restaurant avec son ID interne
        const existing = await this.prisma.restaurant.findUnique({
            where: { ownerId: user.id },
        });

        if(existing) {
            throw new ForbiddenException("Vous avez déjà un restaurant.");
        }

        const { specialties, ...restaurantData } = data;

        // 3. Créer le restaurant en utilisant l'ID interne de l'utilisateur pour la relation
        const resto = await this.prisma.restaurant.create({
            data: {
                ...restaurantData,
                owner: { connect: { id: user.id }},
                // Créer les spécialités si fournies
                ...(specialties?.length && {
                    specialties: {
                        create: specialties.map(name => ({ name })),
                    },
                }),
            },
            include: RESTAURANT_INCLUDE,
        });
        this.logger.log(`Restaurant créé : ${resto.id} par user ${user.id}`);

        return {
            data : resto,
            message: 'Création de restaurant réussie',
        }
    }
     // ─── LECTURE ───────────────────────────────────────────────────────────────

    async findAll() {
        const restaurants = await this.prisma.restaurant.findMany({
            where: { isActive: true },
            include: RESTAURANT_INCLUDE,
            orderBy: { createdAt: 'desc' },
        });
        return { data: restaurants };
    }

    async findOne(id: string) {
    const restaurant = await this.prisma.restaurant.findUnique({
      where: { id },
      include: {
        products: { include: { category: true, variants: true } },
        ...RESTAURANT_WITH_REVIEWS,
      },
    });

    if (!restaurant) {
      throw new NotFoundException(`Restaurant "${id}" non trouvé.`);
    }

    return { data: this.attachRatingStats(restaurant) };
   }
  /**
   * Restaurant du propriétaire connecté.
   * Un user ne peut avoir qu'un seul restaurant — findFirst suffit.
   */
  async findMyRestaurant(firebaseUid: string) {
    const restaurant = await this.prisma.restaurant.findFirst({
      where: { owner: { firebaseUid } },
      include: {
        ...RESTAURANT_INCLUDE,
        _count: { select: { orders: true, products: true } },
      },
    });

    if (!restaurant) {
      throw new NotFoundException('Aucun restaurant trouvé pour ce compte.');
    }

    return { data: restaurant };
   }
   /**
   * Restaurants populaires triés par nombre de commandes.
   * On évite de recalculer avgRating en DB pour garder la query légère.
   */
  async findPopular(limit = 6) {
    const topIds = await this.prisma.order.groupBy({
      by: ['restaurantId'],
      _count: { restaurantId: true },
      orderBy: { _count: { restaurantId: 'desc' } },
      take: limit,
    });

    if (topIds.length === 0) return { data: [] };

    const ids = topIds.map((r) => r.restaurantId);
    const countMap = new Map(topIds.map((r) => [r.restaurantId, r._count.restaurantId]));

    const restaurants = await this.prisma.restaurant.findMany({
      where: { id: { in: ids }, isActive: true },
      include: RESTAURANT_WITH_REVIEWS,
    });

    // Préserve le tri par popularité
    const sorted = ids
      .map((id) => restaurants.find((r) => r.id === id))
      .filter(Boolean)
      .map((r) => ({
        ...this.attachRatingStats(r),
        orderCount: countMap.get(r.id) ?? 0,
      }));

    return { data: sorted };
  }

  // ─── MUTATIONS ─────────────────────────────────────────────────────────────
    /**
     * Met à jour les informations générales du restaurant
     */
    async updateRestaurant(restaurantId: string, firebaseUid: string, dto: UpdateRestaurantDto) {
    const restaurant = await this.verifyOwnership(restaurantId, firebaseUid);

    const updated = await this.prisma.restaurant.update({
      where: { id: restaurant.id },
      data: dto,
      include: RESTAURANT_INCLUDE,
    });

    return { data: updated, message: 'Restaurant mis à jour' };
  }
    /**
     * Met à jour le statut d'ouverture du restaurant
     */
    async updateOpenStatus(restaurantId: string, firebaseUid: string, dto: UpdateOpenStatusDto) {
        const restaurant = await this.verifyOwnership(restaurantId, firebaseUid);

        const updated = await this.prisma.restaurant.update({
            where: { id: restaurant.id },
            data: { isOpen: dto.isOpen, manualOverride: true },
            include: RESTAURANT_INCLUDE,
        });

        return {
            data: updated,
            message: dto.isOpen ? 'Restaurant ouvert (mode manuel)' : 'Restaurant fermé (mode manuel)',
        };
    }

    /**
     * Met à jour les paramètres de livraison du restaurant
     */
    async updateDeliverySettings(
        restaurantId: string,
        firebaseUid: string,
        dto: UpdateDeliverySettingsDto,
    ) {
        const restaurant = await this.verifyOwnership(restaurantId, firebaseUid);

        // Construit l'objet data uniquement avec les champs fournis
        const data: Prisma.RestaurantUpdateInput = {};
        if (dto.fixedDeliveryFee !== undefined) data.fixedDeliveryFee = dto.fixedDeliveryFee;
        if (dto.estimatedDeliveryTimeMin !== undefined) data.estimatedDeliveryTimeMin = dto.estimatedDeliveryTimeMin;
        if (dto.estimatedDeliveryTimeMax !== undefined) data.estimatedDeliveryTimeMax = dto.estimatedDeliveryTimeMax;
        if (dto.minimumOrderAmount !== undefined) data.minimumOrderAmount = dto.minimumOrderAmount;
        if (dto.deliveryPriceMode !== undefined) data.deliveryPriceMode = dto.deliveryPriceMode;

        const updated = await this.prisma.restaurant.update({
        where: { id: restaurant.id },
        data,
        include: RESTAURANT_INCLUDE,
        });

        return { data: updated, message: 'Paramètres de livraison mis à jour' };
  }

    // ─── SPÉCIALITÉS ───────────────────────────────────────────────────────────

    async getSpecialties(restaurantId: string) {
        const specialties = await this.prisma.specialty.findMany({
        where: { restaurantId },
        orderBy: { name: 'asc' },
        });
        return { data: specialties, count: specialties.length };
    }
    

    /**
     * Ajoute une spécialité au restaurant
     */
    async addSpecialty(restaurantId: string, firebaseUid: string, dto: AddSpecialtyDto) {
        const restaurant = await this.verifyOwnership(restaurantId, firebaseUid);

        const existing = await this.prisma.specialty.findUnique({
        where: { restaurantId_name: { restaurantId: restaurant.id, name: dto.name } },
        });
        if (existing) throw new BadRequestException('Cette spécialité existe déjà.');

        const specialty = await this.prisma.specialty.create({
        data: { name: dto.name, restaurantId: restaurant.id },
        });

        return { data: specialty, message: 'Spécialité ajoutée' };
  }

    /**
     * Supprime une spécialité du restaurant
     */
    async removeSpecialty(restaurantId: string, specialtyId: string, firebaseUid: string) {
        const restaurant = await this.verifyOwnership(restaurantId, firebaseUid);

        const specialty = await this.prisma.specialty.findFirst({
            where: {
                id: specialtyId,
                restaurantId: restaurant.id,
            },
        });

        if (!specialty) {
            throw new NotFoundException('Spécialité non trouvée');
        }

        await this.prisma.specialty.delete({
            where: { id: specialtyId },
        });

        return {
            message: 'Spécialité supprimée',
        };
    }


    async findRestaurant(){
        const resto =  await this.prisma.restaurant.findMany({
            where: { isActive: true },
            include: {
                specialties: true,
                operatingHours: true,
            },
            orderBy: { createdAt: 'desc' },
        });
        return {
            data: resto,
            message: 'Restaurant récupéré avec succès'
        }
    }

    // ============ HORAIRES D'OUVERTURE ============

    /**
   * Bulk upsert des horaires de la semaine.
   * Fix : Promise.all au lieu d'awaits séquentiels dans la transaction.
   */
    async setOperatingHours(restaurantId: string, firebaseUid: string, dto: SetOperatingHoursDto) {
        const restaurant = await this.verifyOwnership(restaurantId, firebaseUid);

        const results = await this.prisma.$transaction(async (tx) => {
            // Tous les upserts en parallèle dans la même transaction
            const upserted = await Promise.all(
                dto.hours.map((hour) =>
                tx.operatingHours.upsert({
                    where: {
                    restaurantId_dayOfWeek: {
                        restaurantId: restaurant.id,
                        dayOfWeek: hour.dayOfWeek,
                    },
                    },
                    update: {
                    openTime: hour.openTime,
                    closeTime: hour.closeTime,
                    isClosed: hour.isClosed ?? false,
                    },
                    create: {
                    restaurantId: restaurant.id,
                    dayOfWeek: hour.dayOfWeek,
                    openTime: hour.openTime,
                    closeTime: hour.closeTime,
                    isClosed: hour.isClosed ?? false,
                    },
                }),
                ),
            );

            // Désactive le manualOverride — le cron reprend la main
            await tx.restaurant.update({
                where: { id: restaurant.id },
                data: { manualOverride: false },
            });

            return upserted;
        });

        return {
            data: results,
            message: 'Horaires d\'ouverture mis à jour',
        };
    }

    /**
     * Récupère les horaires d'ouverture d'un restaurant
     */
    async getOperatingHours(restaurantId: string) {
        const restaurant = await this.prisma.restaurant.findUnique({
            where: { id: restaurantId },
        });

        if (!restaurant) {
            throw new NotFoundException('Restaurant non trouvé');
        }

        const hours = await this.prisma.operatingHours.findMany({
            where: { restaurantId },
            orderBy: { dayOfWeek: 'asc' },
        });

        return {
            data: hours,
            count: hours.length,
        };
    }

    /**
     * Met à jour les horaires d'un seul jour
     */
    async updateOperatingHour(restaurantId: string, dayOfWeek: DayOfWeek, firebaseUid: string, dto: UpdateOperatingHourDto) {
        const restaurant = await this.verifyOwnership(restaurantId, firebaseUid);

        const existing = await this.prisma.operatingHours.findUnique({
            where: {
                restaurantId_dayOfWeek: {
                    restaurantId: restaurant.id,
                    dayOfWeek,
                },
            },
        });

        if (!existing) {
            throw new NotFoundException(`Aucun horaire défini pour ${dayOfWeek}`);
        }

        const updated = await this.prisma.operatingHours.update({
            where: { id: existing.id },
            data: {
                ...(dto.openTime !== undefined && { openTime: dto.openTime }),
                ...(dto.closeTime !== undefined && { closeTime: dto.closeTime }),
                ...(dto.isClosed !== undefined && { isClosed: dto.isClosed }),
            },
        });

        return {
            data: updated,
            message: `Horaires de ${dayOfWeek} mis à jour`,
        };
    }

    // ─── ANALYTICS RESTAURANT ─────────────────────────────────────────────────

  /**
   * Nombre total de commandes du restaurant.
   * Fix : prisma.order.count() ne prend pas de select.
   */
    async countOrders(restaurantId: string) {
        const count = await this.prisma.order.count({ where: { restaurantId } });
        return { data: { count }, message: 'Nombre de commandes du restaurant' };
    }

    /**
   * Liste paginée des clients distincts du restaurant.
   * Fix : la pagination s'applique sur les userIds dédupliqués,
   * pas sur les orders brutes (qui peuvent être en milliers).
   */
    async findClients(page = 1, limit = 10, restaurantId: string) {
        const grouped = await this.prisma.order.groupBy({
      by: ['userId'],
      where: { restaurantId },
    });

    if (grouped.length === 0) return { data: [], total: 0 };

    const userIds = grouped.map((g) => g.userId);

    const [clients, total] = await Promise.all([
      this.prisma.user.findMany({
        where: { id: { in: userIds } },
        select: {
          id: true,
          email: true,
          nom: true,
          phone: true,
          imageUrl: true,
          role: true,
          createdAt: true,
        },
        skip: (page - 1) * limit,
        take: limit,
      }),
      Promise.resolve(userIds.length), // total déjà calculé via groupBy
    ]);

    return { data: clients, total, page, limit };
    }

    async findClientWithOrders(restaurantId: string, userId: string) {
    const orders = await this.prisma.order.findMany({
        where: {
            restaurantId,
            userId,
        },
        orderBy: { createdAt: 'desc' },
        // Optionnel : inclure les détails des produits/plats de la commande
        include: {
            items: {
                include: {
                    product: true,
                },
            },
        },
    });

    return {
        data: orders,
        message : "Commandes du client pour ce restaurant"
    };
}
   
   /**
   * Vérifie que l'utilisateur est propriétaire du restaurant (ou ADMIN).
   * Optimisé : 1 seule requête avec include au lieu de 2 séquentielles.
   */
    private async verifyOwnership(restaurantId: string, firebaseUid: string) {
        const restaurant = await this.prisma.restaurant.findUnique({
        where: { id: restaurantId },
        include: { owner: true }, // on récupère le owner en même temps
        });

        if (!restaurant) throw new NotFoundException('Restaurant non trouvé');

        // owner.firebaseUid correspond directement — pas besoin de chercher le user séparément
        if (
        restaurant.owner.firebaseUid !== firebaseUid &&
        restaurant.owner.role !== 'ADMIN'
        ) {
        throw new ForbiddenException("Vous n'êtes pas autorisé à modifier ce restaurant");
        }

        return restaurant;
    }
     /**
   * Calcule et attache les stats de notation sur un restaurant.
   * Extracted pour éviter la duplication dans findOne et findPopular.
   */
  private attachRatingStats<T extends { reviews: { rating: number }[] }>(restaurant: T) {
    const { reviews, ...rest } = restaurant;
    const avgRating =
      reviews.length > 0
        ? reviews.reduce((sum, r) => sum + r.rating, 0) / reviews.length
        : null;

    return {
      ...rest,
      averageRating: avgRating !== null ? Math.round(avgRating * 10) / 10 : null,
      totalReviews: reviews.length,
    };
  }
}
