/* eslint-disable prettier/prettier */
import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import {
    CreateRestaurantDto,
    UpdateDeliverySettingsDto,
    UpdateOpenStatusDto,
    AddSpecialtyDto,
    UpdateRestaurantDto
} from './dto/create-restaurant.dto';

@Injectable()
export class RestaurantsService {
    constructor(private prisma: PrismaService){}

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
                ...(specialties && specialties.length > 0 && {
                    specialties: {
                        create: specialties.map(name => ({ name })),
                    },
                }),
            },
            include: {
                specialties: true,
            },
        });

        return {
            data : resto,
            message: 'Création de restaurant réussie',
        }
    }

    /**
     * Met à jour le statut d'ouverture du restaurant
     */
    async updateOpenStatus(restaurantId: string, firebaseUid: string, dto: UpdateOpenStatusDto) {
        const restaurant = await this.verifyOwnership(restaurantId, firebaseUid);

        const updated = await this.prisma.restaurant.update({
            where: { id: restaurant.id },
            data: { isOpen: dto.isOpen },
            include: { specialties: true },
        });

        return {
            data: updated,
            message: dto.isOpen ? 'Restaurant ouvert' : 'Restaurant fermé',
        };
    }

    /**
     * Met à jour les paramètres de livraison du restaurant
     */
    async updateDeliverySettings(restaurantId: string, firebaseUid: string, dto: UpdateDeliverySettingsDto) {
        const restaurant = await this.verifyOwnership(restaurantId, firebaseUid);

        const updated = await this.prisma.restaurant.update({
            where: { id: restaurant.id },
            data: {
                ...(dto.fixedDeliveryFee !== undefined && { fixedDeliveryFee: dto.fixedDeliveryFee }),
                ...(dto.estimatedDeliveryTimeMin !== undefined && { estimatedDeliveryTimeMin: dto.estimatedDeliveryTimeMin }),
                ...(dto.estimatedDeliveryTimeMax !== undefined && { estimatedDeliveryTimeMax: dto.estimatedDeliveryTimeMax }),
                ...(dto.minimumOrderAmount !== undefined && { minimumOrderAmount: dto.minimumOrderAmount }),
                ...(dto.deliveryPriceMode !== undefined && { deliveryPriceMode: dto.deliveryPriceMode }),
            },
            include: { specialties: true },
        });

        return {
            data: updated,
            message: 'Paramètres de livraison mis à jour',
        };
    }

    /**
     * Met à jour les informations générales du restaurant
     */
    async updateRestaurant(restaurantId: string, firebaseUid: string, dto: UpdateRestaurantDto) {
        const restaurant = await this.verifyOwnership(restaurantId, firebaseUid);

        const updated = await this.prisma.restaurant.update({
            where: { id: restaurant.id },
            data: dto,
            include: { specialties: true },
        });

        return {
            data: updated,
            message: 'Restaurant mis à jour',
        };
    }

    /**
     * Ajoute une spécialité au restaurant
     */
    async addSpecialty(restaurantId: string, firebaseUid: string, dto: AddSpecialtyDto) {
        const restaurant = await this.verifyOwnership(restaurantId, firebaseUid);

        // Vérifier si la spécialité existe déjà
        const existing = await this.prisma.specialty.findUnique({
            where: {
                restaurantId_name: {
                    restaurantId: restaurant.id,
                    name: dto.name,
                },
            },
        });

        if (existing) {
            throw new BadRequestException('Cette spécialité existe déjà pour ce restaurant');
        }

        const specialty = await this.prisma.specialty.create({
            data: {
                name: dto.name,
                restaurantId: restaurant.id,
            },
        });

        return {
            data: specialty,
            message: 'Spécialité ajoutée',
        };
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

    /**
     * Récupère les spécialités d'un restaurant
     */
    async getSpecialties(restaurantId: string) {
        const specialties = await this.prisma.specialty.findMany({
            where: { restaurantId },
            orderBy: { name: 'asc' },
        });

        return {
            data: specialties,
            count: specialties.length,
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

    async findRestaurantOwner(firebaseUid: string){
        const resto =  await this.prisma.restaurant.findMany({
            where: { owner: { firebaseUid } },
            include: {
                specialties: true,
                _count: {
                    select: { orders: true, products: true },
                },
            },
        });

        return {
            data: resto,
            message: 'Restaurant du propriétaire récupéré avec succès'
        }
    }

    async findRestaurant(){
        const resto =  await this.prisma.restaurant.findMany({
            include: {
                specialties: true,
            },
            orderBy: { createdAt: 'desc' },
        });
        return {
            data: resto,
            message: 'Restaurant récupéré avec succès'
        }
    }

    async findOne(id: string) {
        const restaurant = await this.prisma.restaurant.findUnique({
            where: { id },
            include: {
                products: {
                    include: {
                        category: true,
                        variants: true,
                    },
                },
                specialties: true,
            },
        });

        if (!restaurant) {
            throw new NotFoundException(`Restaurant avec l'ID "${id}" non trouvé.`);
        }
        return restaurant;
    }
    // Retourne le nombre de commandes du restaurant
    async findCountOrdersResto(restaurantId: string ){
        // 1. Récupérer toutes les commandes pour le restaurant donné
        const orders = await this.prisma.order.count({
            where: { restaurantId },
            select: {
                userId: true, // On ne sélectionne que l'ID de l'utilisateur pour commencer
            },
        });

        return {
            data: orders,
            message: "Nombre de commandes du restaurant"
        }
    }
    async findClients(page = 1, limit = 10, restaurantId: string) {
        // 1. Récupérer toutes les commandes pour le restaurant donné
        const orders = await this.prisma.order.findMany({
            where: { restaurantId },
            select: {
                userId: true, // On ne sélectionne que l'ID de l'utilisateur pour commencer
                delivery: true
            },
            orderBy: { createdAt: 'desc' },
        });
        if (orders.length === 0) {
            return []; // Pas de commandes, donc pas de clients
        }
        // 2. Extraire les IDs uniques des utilisateurs
        const userIds = [...new Set(orders.map(order => order.userId))];
        // 3. Récupérer les détails des utilisateurs correspondants
        const clients = await this.prisma.user.findMany({
            take: limit,
            skip: (page - 1) * limit,
            where: {
                id: {
                    in: userIds,
                },
            },
            // Optionnel : sélectionner les champs à retourner pour ne pas exposer d'infos sensibles
            select: {
                id: true,
                email: true,
                nom: true,
                phone: true,
                imageUrl: true,
                role: true,
                createdAt: true,
            }
        });
        return {
            data: clients,
            message: 'Listes des clients récupérés avec succès'
        };
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
        message : "Listes des commandes d'un client."
    };
}
    
}
