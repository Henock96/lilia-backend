/* eslint-disable prettier/prettier */
import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
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

    @Get('/nombre-commandes')
    @UseGuards(FirebaseAuthGuard, RolesGuard)
    @Roles('ADMIN', 'RESTAURATEUR')
    findCountOrders(@Req() req) {
        return this.service.findOne(req.user.uid);
    }

    // Endpoint protégé pour que le restaurateur récupère son propre restaurant
    // IMPORTANT: Cette route doit être AVANT :id pour éviter que 'mine' soit interprété comme un ID
    @Get('mine')
    @UseGuards(FirebaseAuthGuard, RolesGuard)
    @Roles('ADMIN', 'RESTAURATEUR')
    findMine(@Req() req) {
        return this.service.findRestaurantOwner(req.user.uid);
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

    // Endpoint pour récupérer les clients d'un restaurant spécifique
    @Get(':id/clients')
    @UseGuards(FirebaseAuthGuard, RolesGuard)
    @Roles('ADMIN', 'RESTAURATEUR')
    findClients(@Param('id') id: string, @Query('page') page: number, @Query('limit') limit: number) {
        // Note : Une vérification supplémentaire pourrait être ajoutée ici 
        // pour s'assurer que le 'RESTAURATEUR' est bien le propriétaire du restaurant 'id'
        return this.service.findClients(page, limit, id);
    }

    @Get(':id/clients/:userId/orders')
    @UseGuards(FirebaseAuthGuard, RolesGuard)
    @Roles('ADMIN', 'RESTAURATEUR')
    async getClientOrders(
        @Param('id') restaurantId: string,
        @Param('userId') userId: string,
    ) {
        return this.service.findClientWithOrders(restaurantId, userId);
    }
}
