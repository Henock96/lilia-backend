/* eslint-disable prettier/prettier */
import { Body, Controller, Get, Param, Post, Req, UseGuards, Request, ForbiddenException } from '@nestjs/common';
import { FirebaseAuthGuard } from 'src/firebase/firebase-auth.guard';
import { RestaurantsService } from './restaurants.service';
import { CreateRestaurantDto } from './dto/create-restaurant.dto';
import { Roles } from 'src/firebase/roles.decorator';
import { RolesGuard } from 'src/firebase/roles.guard';

@Controller('restaurants')
export class RestaurantsController {
    constructor(private readonly service: RestaurantsService){}

    // Endpoint public pour lister tous les restaurants
    @Get()
    findAll() {
        return this.service.findRestaurant();
    }

    // Endpoint public pour récupérer un restaurant par son ID avec ses produits
    @Get(':id')
    findOne(@Param('id') id: string) {
        return this.service.findOne(id);
    }

    // Endpoint protégé pour créer un restaurant
    @Post()
    @UseGuards(FirebaseAuthGuard, RolesGuard)
    @Roles('ADMIN', 'RESTAURATEUR')
    create(@Body() dto: CreateRestaurantDto, @Req() req){
        return this.service.create(dto, req.user.uid)
    }

    // Endpoint protégé pour que le restaurateur récupère son propre restaurant
    @Get('mine')
    @UseGuards(FirebaseAuthGuard, RolesGuard)
    @Roles('ADMIN', 'RESTAURATEUR')
    findMine(@Req() req) {
        return this.service.findMine(req.user.uid);
    }

    // Endpoint pour récupérer les clients d'un restaurant spécifique
    @Get(':id/clients')
    @UseGuards(FirebaseAuthGuard, RolesGuard)
    @Roles('ADMIN', 'RESTAURATEUR')
    findClients(@Param('id') id: string) {
        // Note : Une vérification supplémentaire pourrait être ajoutée ici 
        // pour s'assurer que le 'RESTAURATEUR' est bien le propriétaire du restaurant 'id'
        return this.service.findClients(id);
    }

    @Get(':id/clients/:userId/orders')
    @UseGuards(FirebaseAuthGuard, RolesGuard)
    @Roles('ADMIN', 'RESTAURATEUR')
    async getClientOrders(
        @Param('id') restaurantId: string,
        @Param('userId') userId: string,
        @Request() req,
    ) {
        // Vérifier que l'utilisateur a le droit de voir ces commandes
        const currentUser = req.user;
        
        if (currentUser.id !== userId && currentUser.role !== 'ADMIN') {
            throw new ForbiddenException('Vous n\'avez pas accès à ces commandes');
        }
        
        return this.service.findClientOrders(restaurantId, userId);
    }
}
