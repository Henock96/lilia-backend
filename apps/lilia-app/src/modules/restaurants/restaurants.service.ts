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
import { RESTAURANT_INCLUDE } from './restaurant.includes';
import { RestaurantAccessService } from './restaurant-access.service';
import { RestaurantQueryService } from './restaurant-query.service';
import { RestaurantHoursService } from './restaurant-hours.service';

/**
 * Service restaurants (LIL-145).
 *
 * Conserve la création, les mutations (infos / statut / livraison) et les
 * spécialités, et expose l'API publique historique consommée par
 * RestaurantsController. Les lectures/scoring/analytics et la gestion des
 * horaires sont délégués à des services dédiés :
 *  - lectures + analytics → RestaurantQueryService
 *  - horaires d'ouverture → RestaurantHoursService
 *  - contrôle de propriété → RestaurantAccessService (partagé)
 */
@Injectable()
export class RestaurantsService {
    private readonly logger = new Logger(RestaurantsService.name);

    constructor(
        private prisma: PrismaService,
        private readonly access: RestaurantAccessService,
        private readonly query: RestaurantQueryService,
        private readonly hours: RestaurantHoursService,
    ) {}

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

    // ─── LECTURE (délégué → RestaurantQueryService) ─────────────────────────────

    findAll() {
        return this.query.findAll();
    }

    findOne(id: string) {
        return this.query.findOne(id);
    }

    findMyRestaurant(firebaseUid: string) {
        return this.query.findMyRestaurant(firebaseUid);
    }

    findPopular(limit = 6) {
        return this.query.findPopular(limit);
    }

    findRestaurant() {
        return this.query.findRestaurant();
    }

    // ─── MUTATIONS ─────────────────────────────────────────────────────────────
    /**
     * Met à jour les informations générales du restaurant
     */
    async updateRestaurant(restaurantId: string, firebaseUid: string, dto: UpdateRestaurantDto) {
        const restaurant = await this.access.verifyOwnership(restaurantId, firebaseUid);

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
        const restaurant = await this.access.verifyOwnership(restaurantId, firebaseUid);

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
        const restaurant = await this.access.verifyOwnership(restaurantId, firebaseUid);

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
        const restaurant = await this.access.verifyOwnership(restaurantId, firebaseUid);

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
        const restaurant = await this.access.verifyOwnership(restaurantId, firebaseUid);

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

    // ─── HORAIRES D'OUVERTURE (délégué → RestaurantHoursService) ────────────────

    setOperatingHours(restaurantId: string, firebaseUid: string, dto: SetOperatingHoursDto) {
        return this.hours.setOperatingHours(restaurantId, firebaseUid, dto);
    }

    getOperatingHours(restaurantId: string) {
        return this.hours.getOperatingHours(restaurantId);
    }

    updateOperatingHour(restaurantId: string, dayOfWeek: DayOfWeek, firebaseUid: string, dto: UpdateOperatingHourDto) {
        return this.hours.updateOperatingHour(restaurantId, dayOfWeek, firebaseUid, dto);
    }

    // ─── ANALYTICS / CLIENTS (délégué → RestaurantQueryService) ─────────────────

    countOrders(restaurantId: string) {
        return this.query.countOrders(restaurantId);
    }

    findClients(page = 1, limit = 10, restaurantId: string) {
        return this.query.findClients(page, limit, restaurantId);
    }

    findClientWithOrders(restaurantId: string, userId: string) {
        return this.query.findClientWithOrders(restaurantId, userId);
    }
}
