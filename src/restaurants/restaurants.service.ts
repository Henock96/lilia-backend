/* eslint-disable prettier/prettier */
import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { CreateRestaurantDto } from './dto/create-restaurant.dto';

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

        // 3. Créer le restaurant en utilisant l'ID interne de l'utilisateur pour la relation
        const resto = await this.prisma.restaurant.create({
            data: {
                ...data,
                owner: { connect: { id: user.id }},
            },
        });

        return {
            data : resto,
            message: 'Création de restaurant réussie',
        }
    }

    async findRestaurantOwner(firebaseUid: string){
        const resto =  await this.prisma.restaurant.findMany({
            where: { owner: { firebaseUid } },
        });

        return {
            data: resto,
            message: 'Restaurant du propriétaire récupéré avec succès'
        }
    }

    async findRestaurant(){
        const resto =  await this.prisma.restaurant.findMany();
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
